BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- AlterTable
ALTER TABLE "MarketSectionConfig" ADD COLUMN     "draftDefinition" JSONB,
ADD COLUMN     "draftRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "endsAt" TIMESTAMPTZ(3),
ADD COLUMN     "publishedVersionId" UUID,
ADD COLUMN     "spec" JSONB,
ADD COLUMN     "specVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startsAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "MarketSectionConfigVersion" (
    "id" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "presentation" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedById" UUID,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT statement_timestamp(),
    "reason" VARCHAR(500) NOT NULL,

    CONSTRAINT "MarketSectionConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketSectionConfigVersion_publishedById_idx" ON "MarketSectionConfigVersion"("publishedById");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSectionConfigVersion_configId_version_key" ON "MarketSectionConfigVersion"("configId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSectionConfigVersion_configId_id_key" ON "MarketSectionConfigVersion"("configId", "id");

-- AddForeignKey
ALTER TABLE "MarketSectionConfig" ADD CONSTRAINT "MarketSectionConfig__id_publishedVersionId_fkey" FOREIGN KEY ("_id", "publishedVersionId") REFERENCES "MarketSectionConfigVersion"("configId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MarketSectionConfigVersion" ADD CONSTRAINT "MarketSectionConfigVersion_configId_fkey" FOREIGN KEY ("configId") REFERENCES "MarketSectionConfig"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSectionConfigVersion" ADD CONSTRAINT "MarketSectionConfigVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only small, structured definitions belong in this configuration history.
ALTER TABLE "MarketSectionConfig" ADD CONSTRAINT market_section_draft_check CHECK (
  "draftRevision">=0 AND "specVersion">=0
  AND ("draftDefinition" IS NULL OR (
    jsonb_typeof("draftDefinition")='object'
    AND "draftDefinition" ?& ARRAY['spec','presentation']
    AND ("draftDefinition" - ARRAY['spec','presentation'])='{}'::jsonb
    AND jsonb_typeof("draftDefinition"->'spec')='object'
    AND jsonb_typeof("draftDefinition"->'presentation')='object'
    AND octet_length("draftDefinition"::text)<=65536))
  AND ("startsAt" IS NULL OR isfinite("startsAt"))
  AND ("endsAt" IS NULL OR isfinite("endsAt"))
  AND ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt">"startsAt"));

ALTER TABLE "MarketSectionConfigVersion" ADD CONSTRAINT market_section_version_shape_check CHECK (
  version>0 AND "draftRevision">0 AND "schemaVersion">0 AND "policyVersion">0
  AND jsonb_typeof(spec)='object' AND jsonb_typeof(presentation)='object'
  AND octet_length(spec::text)+octet_length(presentation::text)<=65536
  AND isfinite("publishedAt") AND length(trim(reason))>0);

-- Exact published projection, including presentation; independent draft saves
-- may never leak a new title, audience, order or schedule into the live facade.
CREATE FUNCTION wiez_market_section_presentation(section "MarketSectionConfig")
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object(
    'sectionKey',section."sectionKey", 'title',section.title, 'subtitle',section.subtitle,
    'enabled',section.enabled, 'status',section.status, 'sourceType',section."sourceType",
    'rankingProfileKey',section."rankingProfileKey", 'displayOrder',section."displayOrder",
    'previewItemLimit',section."previewItemLimit", 'detailPageLimit',section."detailPageLimit",
    'minimumItems',section."minimumItems", 'viewAllEnabled',section."viewAllEnabled",
    'viewAllLabel',section."viewAllLabel", 'fallbackMode',section."fallbackMode",
    'fallbackSectionKey',section."fallbackSectionKey", 'guestEnabled',section."guestEnabled",
    'requiresAuth',section."requiresAuth", 'newBrandReservedRatio',section."newBrandReservedRatio",
    'metadata',section.metadata,
    'startsAt',to_char(section."startsAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(section."endsAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;

CREATE FUNCTION wiez_market_section_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE published "MarketSectionConfigVersion";
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."draftRevision"<>OLD."draftRevision"
      AND (NEW."draftRevision"<>OLD."draftRevision"+1 OR NEW."draftDefinition" IS NULL) THEN
      RAISE EXCEPTION 'Section draft revision must advance one step with a definition' USING ERRCODE='23514';
    END IF;
    IF NEW."draftDefinition" IS DISTINCT FROM OLD."draftDefinition"
      AND NEW."draftRevision"<>OLD."draftRevision"+1 THEN
      RAISE EXCEPTION 'Section draft save requires its next revision' USING ERRCODE='23514';
    END IF;
    IF NEW."publishedVersionId" IS DISTINCT FROM OLD."publishedVersionId" THEN
      IF NEW."publishedVersionId" IS NULL OR NEW."specVersion"<>OLD."specVersion"+1 THEN
        RAISE EXCEPTION 'Publish or restore must create the next section version' USING ERRCODE='23514';
      END IF;
    ELSIF NEW."specVersion"<>OLD."specVersion" THEN
      RAISE EXCEPTION 'Section version counter cannot change without publication' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW."publishedVersionId" IS NULL THEN
    IF NEW.spec IS NOT NULL OR NEW."specVersion"<>0 OR NEW."startsAt" IS NOT NULL OR NEW."endsAt" IS NOT NULL THEN
      RAISE EXCEPTION 'V2 section serving fields require a published version' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO published FROM "MarketSectionConfigVersion"
    WHERE id=NEW."publishedVersionId" AND "configId"=NEW."_id";
  IF NOT FOUND OR published.version<>NEW."specVersion"
    OR published.spec IS DISTINCT FROM NEW.spec
    OR published.presentation IS DISTINCT FROM wiez_market_section_presentation(NEW) THEN
    RAISE EXCEPTION 'Section serving fields must match the immutable published definition' USING ERRCODE='23514';
  END IF;
  IF NEW."previewItemLimit" NOT BETWEEN 1 AND 12 OR NEW."detailPageLimit" NOT BETWEEN 1 AND 60
    OR NEW."minimumItems" NOT BETWEEN 0 AND 12
    OR NEW."displayOrder"<0
    OR NEW."newBrandReservedRatio" NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION 'Published section limits are outside their bounded range' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_section_projection_guard BEFORE INSERT OR UPDATE
  ON "MarketSectionConfig" FOR EACH ROW EXECUTE FUNCTION wiez_market_section_projection_guard();

CREATE FUNCTION wiez_market_section_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config "MarketSectionConfig";
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Published section history cannot be deleted' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    -- Account erasure deidentifies the author without rewriting the definition.
    IF NEW."publishedById" IS NULL
      AND (to_jsonb(NEW)-'publishedById')=(to_jsonb(OLD)-'publishedById') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Published section versions are immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO config FROM "MarketSectionConfig" WHERE "_id"=NEW."configId" FOR UPDATE;
  IF NOT FOUND OR NEW.version<>config."specVersion"+1 OR NEW."draftRevision"<>config."draftRevision"
    OR config."draftDefinition" IS NULL
    OR config."draftDefinition" IS DISTINCT FROM jsonb_build_object('spec',NEW.spec,'presentation',NEW.presentation) THEN
    RAISE EXCEPTION 'Section publication requires the current complete draft and next version' USING ERRCODE='23514';
  END IF;
  NEW."publishedAt" := statement_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_section_version_guard BEFORE INSERT OR UPDATE OR DELETE
  ON "MarketSectionConfigVersion" FOR EACH ROW EXECUTE FUNCTION wiez_market_section_version_guard();

CREATE FUNCTION wiez_market_section_publication_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "MarketSectionConfig" WHERE "_id"=NEW."configId"
    AND "publishedVersionId"=NEW.id AND "specVersion"=NEW.version) THEN
    RAISE EXCEPTION 'Section snapshot and serving pointer must publish atomically' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_market_section_publication_commit_guard AFTER INSERT
  ON "MarketSectionConfigVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION wiez_market_section_publication_commit_guard();

COMMIT;
