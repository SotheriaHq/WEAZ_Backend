BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- CreateEnum
CREATE TYPE "ProductComplementStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SearchSynonymKind" AS ENUM ('TERM', 'COLOR', 'BRAND_ALIAS');

-- AlterTable
ALTER TABLE "CollectionCategory" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "CollectionCategoryType" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ProductComplement" (
    "productId" UUID NOT NULL,
    "complementId" UUID NOT NULL,
    "status" "ProductComplementStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductComplement_pkey" PRIMARY KEY ("productId","complementId")
);

-- CreateTable
CREATE TABLE "SearchSynonym" (
    "id" UUID NOT NULL,
    "kind" "SearchSynonymKind" NOT NULL,
    "term" VARCHAR(120) NOT NULL,
    "canonical" VARCHAR(120) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SearchSynonym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketChipSet" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "surface" "FeedCategorySurface" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "chips" JSONB NOT NULL,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "status" "FeedCategoryStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MarketChipSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductComplement_complementId_idx" ON "ProductComplement"("complementId");

-- CreateIndex
CREATE INDEX "ProductComplement_status_productId_idx" ON "ProductComplement"("status", "productId");

-- CreateIndex
CREATE INDEX "ProductComplement_createdById_idx" ON "ProductComplement"("createdById");

-- CreateIndex
CREATE INDEX "ProductComplement_reviewedById_idx" ON "ProductComplement"("reviewedById");

-- CreateIndex
CREATE INDEX "SearchSynonym_kind_canonical_idx" ON "SearchSynonym"("kind", "canonical");

-- CreateIndex
CREATE INDEX "SearchSynonym_createdById_idx" ON "SearchSynonym"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "SearchSynonym_kind_term_key" ON "SearchSynonym"("kind", "term");

-- CreateIndex
CREATE UNIQUE INDEX "MarketChipSet_key_key" ON "MarketChipSet"("key");

-- CreateIndex
CREATE INDEX "MarketChipSet_surface_status_startsAt_idx" ON "MarketChipSet"("surface", "status", "startsAt");

-- AddForeignKey
ALTER TABLE "ProductComplement" ADD CONSTRAINT "ProductComplement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComplement" ADD CONSTRAINT "ProductComplement_complementId_fkey" FOREIGN KEY ("complementId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComplement" ADD CONSTRAINT "ProductComplement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComplement" ADD CONSTRAINT "ProductComplement_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchSynonym" ADD CONSTRAINT "SearchSynonym_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductComplement" ADD CONSTRAINT product_complement_shape_check CHECK (
  "productId"<>"complementId" AND isfinite("createdAt")
  AND ("reviewedAt" IS NULL OR isfinite("reviewedAt"))
  AND ((status='PENDING' AND "reviewedAt" IS NULL)
    OR (status<>'PENDING' AND "reviewedAt" IS NOT NULL)));

ALTER TABLE "SearchSynonym" ADD CONSTRAINT search_synonym_shape_check CHECK (
  length(trim(term))>0 AND length(trim(canonical))>0 AND term<>canonical
  AND term=lower(trim(normalize(term,NFKC)))
  AND canonical=lower(trim(normalize(canonical,NFKC))));

-- A graph mutation uses SERIALIZABLE isolation and retry-on-40001 in the
-- vocabulary service. Merely taking a Redis/advisory lease would not prevent
-- two old database snapshots from concurrently inserting a cycle.
CREATE FUNCTION wiez_search_synonym_normalize_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'serializable' THEN
    RAISE EXCEPTION 'Synonym graph changes require a serializable transaction' USING ERRCODE='23514';
  END IF;
  NEW.term := lower(trim(normalize(NEW.term,NFKC)));
  NEW.canonical := lower(trim(normalize(NEW.canonical,NFKC)));
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_search_synonym_normalize_guard BEFORE INSERT OR UPDATE OF kind,term,canonical
  ON "SearchSynonym" FOR EACH ROW EXECUTE FUNCTION wiez_search_synonym_normalize_guard();

CREATE FUNCTION wiez_search_synonym_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invalid boolean;
BEGIN
  WITH RECURSIVE walk(node,path,depth,cycle) AS (
    SELECT NEW.canonical,ARRAY[NEW.term]::text[],0,NEW.canonical=NEW.term
    UNION ALL
    SELECT s.canonical,w.path||w.node,w.depth+1,s.canonical=ANY(w.path||w.node)
      FROM walk w JOIN "SearchSynonym" s ON s.kind=NEW.kind AND s.term=w.node
      WHERE NOT w.cycle AND w.depth<128)
  SELECT coalesce(bool_or(cycle OR depth=128),false) INTO invalid FROM walk;
  IF invalid THEN
    RAISE EXCEPTION 'Synonym chain is cyclic or exceeds the bounded traversal depth' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_search_synonym_cycle_guard AFTER INSERT OR UPDATE OF kind,term,canonical
  ON "SearchSynonym" FOR EACH ROW EXECUTE FUNCTION wiez_search_synonym_cycle_guard();

CREATE FUNCTION wiez_market_chips_shape_valid(chips jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE chip jsonb;
BEGIN
  IF chips IS NULL OR jsonb_typeof(chips)<>'array' OR jsonb_array_length(chips)>8
    OR octet_length(chips::text)>32768 THEN RETURN FALSE; END IF;
  FOR chip IN SELECT value FROM jsonb_array_elements(chips) LOOP
    IF jsonb_typeof(chip)<>'object' OR NOT(chip ?& ARRAY['label','filters'])
      OR (chip-ARRAY['label','filters'])<>'{}'::jsonb
      OR jsonb_typeof(chip->'label')<>'string' OR length(trim(chip->>'label'))=0
      OR length(chip->>'label')>120 OR jsonb_typeof(chip->'filters')<>'object' THEN RETURN FALSE; END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;
ALTER TABLE "MarketChipSet" ADD CONSTRAINT market_chipset_shape_check CHECK (
  key ~ '^[a-z0-9][a-z0-9-]{0,79}$' AND length(trim(label))>0
  AND wiez_market_chips_shape_valid(chips)
  AND (status<>'ACTIVE' OR jsonb_array_length(chips)>0)
  AND ("startsAt" IS NULL OR isfinite("startsAt"))
  AND ("endsAt" IS NULL OR isfinite("endsAt"))
  AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt">"startsAt"));

-- Built-in range GiST operators avoid requiring an extra PostgreSQL extension.
-- Windows are [start,end); adjacent scheduled sets are allowed. The exclusion
-- constraint arbitrates concurrent writers in PostgreSQL, including snapshots.
ALTER TABLE "MarketChipSet" ADD CONSTRAINT market_chipset_active_window_excl
  EXCLUDE USING gist (
    (int4range(CASE surface WHEN 'DESIGN_FEED' THEN 0 ELSE 1 END,
      CASE surface WHEN 'DESIGN_FEED' THEN 1 ELSE 2 END,'[)')) WITH &&,
    (tstzrange("startsAt","endsAt",'[)')) WITH &&)
  WHERE (status='ACTIVE');

CREATE FUNCTION wiez_taxonomy_aliases_valid(aliases text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT aliases IS NOT NULL AND cardinality(aliases)<=32
    AND NOT EXISTS(SELECT 1 FROM unnest(aliases) value WHERE value IS NULL
      OR length(trim(value))=0 OR length(value)>120 OR value ~ '[[:cntrl:]]')
    AND cardinality(aliases)=(SELECT count(DISTINCT lower(trim(normalize(value,NFKC)))) FROM unnest(aliases) value);
$$;
ALTER TABLE "CollectionCategory" ADD CONSTRAINT category_aliases_shape_check
  CHECK (wiez_taxonomy_aliases_valid(aliases)) NOT VALID;
ALTER TABLE "CollectionCategoryType" ADD CONSTRAINT category_type_aliases_shape_check
  CHECK (wiez_taxonomy_aliases_valid(aliases)) NOT VALID;

-- Aliases never approve taxonomy. Public readers must retain the canonical
-- active/approved taxonomy gate, independent of design/product approval.
COMMIT;
