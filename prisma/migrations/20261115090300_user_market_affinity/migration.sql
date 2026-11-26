BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- CreateEnum
CREATE TYPE "MarketEvidenceCompleteness" AS ENUM ('UNAVAILABLE', 'PARTIAL', 'COMPLETE');

-- CreateTable
CREATE TABLE "user_market_affinity" (
    "userId" UUID NOT NULL,
    "brands" JSONB NOT NULL DEFAULT '[]',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "dimensions" JSONB NOT NULL DEFAULT '[]',
    "recentBrands" JSONB NOT NULL DEFAULT '[]',
    "recentCategories" JSONB NOT NULL DEFAULT '[]',
    "recentDimensions" JSONB NOT NULL DEFAULT '[]',
    "priceBand" VARCHAR(2),
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hardActions" INTEGER,
    "recentOpens" INTEGER,
    "recentHardActions" INTEGER,
    "sourceWindowStart" TIMESTAMPTZ(3) NOT NULL,
    "sourceWindowEnd" TIMESTAMPTZ(3) NOT NULL,
    "sourceCompleteness" "MarketEvidenceCompleteness" NOT NULL DEFAULT 'UNAVAILABLE',
    "recentWindowStart" TIMESTAMPTZ(3),
    "recentWindowEnd" TIMESTAMPTZ(3),
    "recentCompleteness" "MarketEvidenceCompleteness" NOT NULL DEFAULT 'UNAVAILABLE',
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT statement_timestamp(),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_market_affinity_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "user_market_affinity_expiresAt_userId_idx" ON "user_market_affinity"("expiresAt", "userId");

-- AddForeignKey
ALTER TABLE "user_market_affinity" ADD CONSTRAINT "user_market_affinity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE FUNCTION wiez_affinity_vector_valid(document jsonb, max_items integer, dimensions boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE item jsonb; field text; identity_count integer; uuid_pattern text :=
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF document IS NULL OR jsonb_typeof(document)<>'array'
    OR jsonb_array_length(document)>max_items OR octet_length(document::text)>8192 THEN RETURN FALSE; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(document) LOOP
    IF jsonb_typeof(item)<>'object' OR NOT(item ? 'w')
      OR jsonb_typeof(item->'w')<>'number' THEN RETURN FALSE; END IF;
    IF (item->>'w')::numeric < -1 OR (item->>'w')::numeric > 1 THEN RETURN FALSE; END IF;
    IF dimensions THEN
      IF NOT(item ? 'dimension' AND item ? 'value')
        OR jsonb_typeof(item->'dimension')<>'string' OR jsonb_typeof(item->'value')<>'string'
        OR (item->>'dimension') !~ uuid_pattern OR (item->>'value') !~ uuid_pattern THEN RETURN FALSE; END IF;
      FOR field IN SELECT jsonb_object_keys(item) LOOP
        IF field NOT IN ('dimension','value','w') THEN RETURN FALSE; END IF;
      END LOOP;
    ELSE
      IF NOT(item ? 'id') OR jsonb_typeof(item->'id')<>'string'
        OR (item->>'id') !~ uuid_pattern THEN RETURN FALSE; END IF;
      FOR field IN SELECT jsonb_object_keys(item) LOOP
        IF field NOT IN ('id','w') THEN RETURN FALSE; END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF dimensions THEN
    SELECT count(DISTINCT ROW(value->>'dimension',value->>'value')) INTO identity_count
      FROM jsonb_array_elements(document);
  ELSE
    SELECT count(DISTINCT value->>'id') INTO identity_count FROM jsonb_array_elements(document);
  END IF;
  RETURN identity_count=jsonb_array_length(document);
END;
$$;

CREATE FUNCTION wiez_affinity_sizes_valid(sizes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(sizes)<=64 AND NOT EXISTS(SELECT 1 FROM unnest(sizes) value
    WHERE value IS NULL OR length(trim(value))=0 OR length(value)>32 OR value ~ '[[:cntrl:]]');
$$;

ALTER TABLE user_market_affinity ADD CONSTRAINT user_market_affinity_shape_check CHECK(
  wiez_affinity_vector_valid(brands,20,false)
  AND wiez_affinity_vector_valid(categories,10,false)
  AND wiez_affinity_vector_valid(dimensions,20,true)
  AND wiez_affinity_vector_valid("recentBrands",20,false)
  AND wiez_affinity_vector_valid("recentCategories",10,false)
  AND wiez_affinity_vector_valid("recentDimensions",20,true)
  AND sizes IS NOT NULL AND wiez_affinity_sizes_valid(sizes)
  AND ("priceBand" IS NULL OR "priceBand" IN ('P0','P1','P2','P3'))
  AND ("hardActions" IS NULL OR "hardActions">=0)
  AND ("recentOpens" IS NULL OR "recentOpens">=0)
  AND ("recentHardActions" IS NULL OR "recentHardActions">=0)
  AND "featureSchemaVersion">0
  AND isfinite("sourceWindowStart") AND isfinite("sourceWindowEnd")
  AND isfinite("computedAt") AND isfinite("expiresAt")
  AND "sourceWindowStart"<="sourceWindowEnd" AND "sourceWindowEnd"<="computedAt"
  AND "expiresAt">"computedAt"
  AND ("sourceCompleteness"<>'UNAVAILABLE' OR ("hardActions" IS NULL AND "recentOpens" IS NULL
    AND brands='[]'::jsonb AND categories='[]'::jsonb AND dimensions='[]'::jsonb
    AND "priceBand" IS NULL AND cardinality(sizes)=0))
  AND (("recentWindowStart" IS NULL)=("recentWindowEnd" IS NULL))
  AND ("recentWindowStart" IS NULL OR (isfinite("recentWindowStart") AND isfinite("recentWindowEnd")
    AND "recentWindowStart"<="recentWindowEnd" AND "recentWindowEnd"<="computedAt"))
  AND ("recentCompleteness"='UNAVAILABLE' OR "recentWindowStart" IS NOT NULL)
  AND ("recentCompleteness"<>'UNAVAILABLE' OR ("recentHardActions" IS NULL
    AND "recentBrands"='[]'::jsonb AND "recentCategories"='[]'::jsonb AND "recentDimensions"='[]'::jsonb))
  AND ((jsonb_array_length("recentBrands")=0 AND jsonb_array_length("recentCategories")=0
    AND jsonb_array_length("recentDimensions")=0) OR "recentWindowStart" IS NOT NULL));

-- Index only entity IDs, not changing floating-point weights, for bounded
-- removal/recalculation when a referenced brand is erased.
CREATE INDEX user_market_affinity_brand_ids_idx ON user_market_affinity
  USING GIN (jsonb_path_query_array(brands,'$[*].id'));
CREATE INDEX user_market_affinity_recent_brand_ids_idx ON user_market_affinity
  USING GIN (jsonb_path_query_array("recentBrands",'$[*].id'));

COMMIT;
