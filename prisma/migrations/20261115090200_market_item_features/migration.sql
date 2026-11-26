BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- CreateEnum
CREATE TYPE "MarketFeatureEpochStatus" AS ENUM ('BUILDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "market_item_features" (
    "productId" UUID NOT NULL,
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceAsOf" TIMESTAMPTZ(3) NOT NULL,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "purchasable" BOOLEAN NOT NULL DEFAULT false,
    "minVariantStock" INTEGER,
    "lowStockVariants" INTEGER NOT NULL DEFAULT 0,
    "actors7d" INTEGER,
    "actors28d" INTEGER,
    "intent3d" DOUBLE PRECISION,
    "intent28d" DOUBLE PRECISION,
    "impressions28d" INTEGER,
    "decayedPopularity" DOUBLE PRECISION,
    "trendEligible" BOOLEAN NOT NULL DEFAULT false,
    "trendScore" DOUBLE PRECISION,
    "qualityScore" DOUBLE PRECISION,
    "units28d" INTEGER,
    "savesCount" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_item_features_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "market_item_features_regional" (
    "productId" UUID NOT NULL,
    "state" VARCHAR(64) NOT NULL,
    "intent28d" DOUBLE PRECISION,
    "actors28d" INTEGER,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_item_features_regional_pkey" PRIMARY KEY ("productId","state")
);

-- CreateTable
CREATE TABLE "market_feature_state" (
    "key" VARCHAR(80) NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "generation" BIGINT NOT NULL DEFAULT 0,
    "currentEpochId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "market_feature_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "market_feature_epochs" (
    "id" UUID NOT NULL,
    "stateKey" VARCHAR(80) NOT NULL,
    "writerXid" xid8,
    "generation" BIGINT NOT NULL,
    "epochStart" TIMESTAMPTZ(3) NOT NULL,
    "epochEnd" TIMESTAMPTZ(3) NOT NULL,
    "featureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "MarketFeatureEpochStatus" NOT NULL DEFAULT 'BUILDING',
    "buildStartedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMPTZ(3),
    "sourceAsOf" TIMESTAMPTZ(3) NOT NULL,
    "acceptUntil" TIMESTAMPTZ(3) NOT NULL,
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "cleanupAfter" TIMESTAMPTZ(3) NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(40),

    CONSTRAINT "market_feature_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_item_feature_snapshots" (
    "epochId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sourceComputedAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceFeatureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "sourcePolicyVersion" INTEGER NOT NULL DEFAULT 1,
    "sourceAsOf" TIMESTAMPTZ(3) NOT NULL,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "purchasable" BOOLEAN NOT NULL DEFAULT false,
    "minVariantStock" INTEGER,
    "lowStockVariants" INTEGER NOT NULL DEFAULT 0,
    "actors7d" INTEGER,
    "actors28d" INTEGER,
    "intent3d" DOUBLE PRECISION,
    "intent28d" DOUBLE PRECISION,
    "impressions28d" INTEGER,
    "decayedPopularity" DOUBLE PRECISION,
    "trendEligible" BOOLEAN NOT NULL DEFAULT false,
    "trendScore" DOUBLE PRECISION,
    "qualityScore" DOUBLE PRECISION,
    "units28d" INTEGER,
    "savesCount" INTEGER,

    CONSTRAINT "market_item_feature_snapshots_pkey" PRIMARY KEY ("epochId","productId")
);

-- CreateIndex
CREATE INDEX "market_item_features_trendEligible_trendScore_idx" ON "market_item_features"("trendEligible", "trendScore" DESC);

-- CreateIndex
CREATE INDEX "market_item_features_decayedPopularity_idx" ON "market_item_features"("decayedPopularity" DESC);

-- CreateIndex
CREATE INDEX "market_item_features_lowStockVariants_minVariantStock_idx" ON "market_item_features"("lowStockVariants", "minVariantStock");

-- CreateIndex
CREATE INDEX "market_item_features_computedAt_productId_idx" ON "market_item_features"("computedAt", "productId");

-- CreateIndex
CREATE INDEX "market_item_features_regional_state_intent28d_idx" ON "market_item_features_regional"("state", "intent28d" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "market_feature_state_key_currentEpochId_key" ON "market_feature_state"("key", "currentEpochId");

-- CreateIndex
CREATE INDEX "market_feature_epochs_stateKey_status_epochStart_idx" ON "market_feature_epochs"("stateKey", "status", "epochStart" DESC);

-- CreateIndex
CREATE INDEX "market_feature_epochs_cleanupAfter_status_idx" ON "market_feature_epochs"("cleanupAfter", "status");

-- CreateIndex
CREATE UNIQUE INDEX "market_feature_epochs_stateKey_generation_key" ON "market_feature_epochs"("stateKey", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "market_feature_epochs_stateKey_id_key" ON "market_feature_epochs"("stateKey", "id");

-- CreateIndex
CREATE INDEX "market_item_feature_snapshots_epochId_trendEligible_trendSc_idx" ON "market_item_feature_snapshots"("epochId", "trendEligible" DESC, "trendScore" DESC, "decayedPopularity" DESC, "productId");

-- CreateIndex
CREATE INDEX "market_item_feature_snapshots_epochId_decayedPopularity_pro_idx" ON "market_item_feature_snapshots"("epochId", "decayedPopularity" DESC, "productId");

-- CreateIndex
CREATE INDEX "market_item_feature_snapshots_epochId_lowStockVariants_minV_idx" ON "market_item_feature_snapshots"("epochId", "lowStockVariants", "minVariantStock", "productId");

CREATE INDEX "market_item_feature_snapshots_epochId_savesCount_productId_idx"
  ON "market_item_feature_snapshots"("epochId","savesCount" DESC,"productId");
CREATE INDEX "market_item_feature_snapshots_epochId_units28d_productId_idx"
  ON "market_item_feature_snapshots"("epochId","units28d" DESC,"productId");

-- AddForeignKey
ALTER TABLE "market_item_features" ADD CONSTRAINT "market_item_features_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_item_features_regional" ADD CONSTRAINT "market_item_features_regional_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_feature_state" ADD CONSTRAINT "market_feature_state_key_currentEpochId_fkey" FOREIGN KEY ("key", "currentEpochId") REFERENCES "market_feature_epochs"("stateKey", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_feature_epochs" ADD CONSTRAINT "market_feature_epochs_stateKey_fkey" FOREIGN KEY ("stateKey") REFERENCES "market_feature_state"("key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "market_item_feature_snapshots" ADD CONSTRAINT "market_item_feature_snapshots_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "market_feature_epochs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_item_feature_snapshots" ADD CONSTRAINT "market_item_feature_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Coverage contains only bounded status/date evidence, never actor identifiers.
CREATE FUNCTION wiez_market_coverage_valid(document jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE metric record; item record; value_text text;
BEGIN
  IF document IS NULL OR jsonb_typeof(document) <> 'object'
    OR octet_length(document::text) > 8192 THEN RETURN FALSE; END IF;
  FOR metric IN SELECT key, value FROM jsonb_each(document) LOOP
    IF metric.key NOT IN ('actors7d','actors28d','intent3d','intent28d',
      'impressions28d','decayedPopularity','trendScore','qualityScore','units28d','savesCount')
      OR jsonb_typeof(metric.value) <> 'object' THEN RETURN FALSE; END IF;
    IF COALESCE(metric.value->>'completeness','') NOT IN ('UNAVAILABLE','PARTIAL','COMPLETE')
      OR COALESCE(metric.value->>'reason','') NOT IN
        ('R1_HISTORY_UNAVAILABLE','MISSING_IMPRESSIONS','STALE_SOURCE',
         'INCOMPLETE_REFRESH','SOURCE_COMPLETE','ITEM_LIFETIME_COMPLETE',
         'SOURCE_UNAVAILABLE','INSUFFICIENT_ATTRIBUTION') THEN RETURN FALSE; END IF;
    FOR item IN SELECT key, value FROM jsonb_each(metric.value) LOOP
      IF item.key IN ('completeness','reason') THEN
        IF jsonb_typeof(item.value) <> 'string' THEN RETURN FALSE; END IF;
      ELSIF item.key IN ('requiredWindowStart','requiredWindowEnd',
        'observedFrom','observedThrough','knownEmptyBefore') THEN
        value_text := item.value #>> '{}';
        IF jsonb_typeof(item.value) <> 'string'
          OR value_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          OR NOT pg_input_is_valid(value_text,'pg_catalog.timestamptz') THEN RETURN FALSE; END IF;
      ELSE RETURN FALSE;
      END IF;
    END LOOP;
    IF NOT (metric.value ? 'requiredWindowStart' AND metric.value ? 'requiredWindowEnd')
      OR (metric.value->>'requiredWindowStart')::timestamptz >
         (metric.value->>'requiredWindowEnd')::timestamptz THEN RETURN FALSE; END IF;
    IF metric.value->>'completeness' = 'COMPLETE' THEN
      IF NOT (metric.value ? 'observedFrom' AND metric.value ? 'observedThrough')
        THEN RETURN FALSE; END IF;
      IF (metric.value->>'observedFrom')::timestamptz > (metric.value->>'observedThrough')::timestamptz
        OR (metric.value->>'observedThrough')::timestamptz < (metric.value->>'requiredWindowEnd')::timestamptz
        THEN RETURN FALSE; END IF;
      IF (metric.value->>'observedFrom')::timestamptz > (metric.value->>'requiredWindowStart')::timestamptz
        AND NOT (metric.value ? 'knownEmptyBefore'
          AND (metric.value->>'observedFrom')::timestamptz <= (metric.value->>'knownEmptyBefore')::timestamptz
          AND (metric.value->>'knownEmptyBefore')::timestamptz <= (metric.value->>'requiredWindowEnd')::timestamptz)
        THEN RETURN FALSE; END IF;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION wiez_market_parameters_valid(document jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE item record;
BEGIN
  IF document IS NULL OR jsonb_typeof(document) <> 'object'
    OR octet_length(document::text) > 2048 THEN RETURN FALSE; END IF;
  FOR item IN SELECT key, value FROM jsonb_each(document) LOOP
    IF item.key NOT IN ('halfLifeDays','lookbackDays','featureSchemaVersion',
      'policyVersion','smoothingAlpha','smoothingBeta','trendActorFloor',
      'qualityPriorStrength','qualityPriorMean') OR jsonb_typeof(item.value) <> 'number'
      THEN RETURN FALSE; END IF;
    CASE item.key
      WHEN 'featureSchemaVersion','policyVersion' THEN
        IF (item.value::text)::numeric < 1 OR (item.value::text)::numeric > 2147483647
          OR trunc((item.value::text)::numeric) <> (item.value::text)::numeric THEN RETURN FALSE; END IF;
      WHEN 'halfLifeDays' THEN
        IF (item.value::text)::numeric < 1 OR (item.value::text)::numeric > 30 THEN RETURN FALSE; END IF;
      WHEN 'lookbackDays' THEN
        IF (item.value::text)::numeric < 1 OR (item.value::text)::numeric > 90 THEN RETURN FALSE; END IF;
      WHEN 'trendActorFloor' THEN
        IF (item.value::text)::numeric < 3 OR (item.value::text)::numeric > 50
          OR trunc((item.value::text)::numeric) <> (item.value::text)::numeric THEN RETURN FALSE; END IF;
      WHEN 'qualityPriorMean' THEN
        IF (item.value::text)::numeric <= 0 OR (item.value::text)::numeric >= 1 THEN RETURN FALSE; END IF;
      WHEN 'qualityPriorStrength' THEN
        IF (item.value::text)::numeric <= 0 OR (item.value::text)::numeric > 1000 THEN RETURN FALSE; END IF;
      ELSE
        IF (item.value::text)::numeric < 0 OR (item.value::text)::numeric > 1000 THEN RETURN FALSE; END IF;
    END CASE;
  END LOOP;
  RETURN TRUE;
END;
$$;

ALTER TABLE market_feature_state
  ADD CONSTRAINT market_feature_state_parameters_check CHECK(wiez_market_parameters_valid(parameters)),
  ADD CONSTRAINT market_feature_state_generation_check CHECK(generation >= 0 AND length(trim(key)) > 0);
ALTER TABLE market_feature_epochs
  ADD CONSTRAINT market_feature_epoch_shape_check CHECK(
    generation > 0 AND "featureSchemaVersion" > 0 AND "policyVersion" > 0
    AND "epochStart" < "epochEnd" AND "acceptUntil" <= "epochEnd"
    AND "cleanupAfter" >= "acceptUntil" AND "rowCount" >= 0
    AND (status <> 'READY' OR ("readyAt" IS NOT NULL AND "writerXid" IS NOT NULL))
    AND (status = 'READY' OR "readyAt" IS NULL)),
  ADD CONSTRAINT market_feature_epoch_parameters_check CHECK(wiez_market_parameters_valid(parameters)
    AND (NOT(parameters ? 'policyVersion') OR (parameters->>'policyVersion')::numeric="policyVersion")
    AND (NOT(parameters ? 'featureSchemaVersion') OR (parameters->>'featureSchemaVersion')::numeric="featureSchemaVersion"));
-- Generation IDs, rather than a unique time bucket, identify frozen views.
-- A later refresh may publish a new immutable generation in the same bucket.

CREATE FUNCTION wiez_market_feature_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target market_feature_epochs%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.key <> OLD.key OR NEW.parameters IS DISTINCT FROM OLD.parameters
      OR NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'Feature state identity is immutable and generation cannot decrease' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW."currentEpochId" IS NOT NULL AND
    (TG_OP = 'INSERT' OR NEW."currentEpochId" IS DISTINCT FROM OLD."currentEpochId") THEN
    SELECT * INTO target FROM market_feature_epochs WHERE id=NEW."currentEpochId";
    IF NOT FOUND OR target.status <> 'READY' OR target."stateKey" <> NEW.key
      OR target.generation <> NEW.generation OR target.parameters IS DISTINCT FROM NEW.parameters
      OR target."acceptUntil" <= statement_timestamp() THEN
      RAISE EXCEPTION 'Current feature snapshot must be ready, current and unexpired' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_feature_state_guard BEFORE INSERT OR UPDATE ON market_feature_state
  FOR EACH ROW EXECUTE FUNCTION wiez_market_feature_state_guard();

CREATE FUNCTION wiez_market_feature_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE copied bigint; expected_rows bigint; matched_rows bigint; invalid_source boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'BUILDING' OR NEW."writerXid" IS NOT NULL THEN
      RAISE EXCEPTION 'A feature generation must begin unclaimed and building' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status='READY' AND (OLD."cleanupAfter" > statement_timestamp()
      OR EXISTS(SELECT 1 FROM market_feature_state WHERE "currentEpochId"=OLD.id)) THEN
      RAISE EXCEPTION 'A retained or current feature snapshot cannot be pruned' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status='READY' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Published feature generations are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW."stateKey",NEW.generation,NEW."epochStart",NEW."epochEnd",
      NEW."featureSchemaVersion",NEW."policyVersion",NEW.parameters,
      NEW."acceptUntil",NEW."cleanupAfter",NEW."buildStartedAt") IS DISTINCT FROM
    ROW(OLD.id,OLD."stateKey",OLD.generation,OLD."epochStart",OLD."epochEnd",
      OLD."featureSchemaVersion",OLD."policyVersion",OLD.parameters,
      OLD."acceptUntil",OLD."cleanupAfter",OLD."buildStartedAt") THEN
    RAISE EXCEPTION 'Feature generation identity cannot change' USING ERRCODE='23514';
  END IF;
  IF OLD.status='FAILED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A failed feature generation must be replaced, not rewritten' USING ERRCODE='23514';
  END IF;
  IF NEW."writerXid" IS DISTINCT FROM OLD."writerXid" THEN
    IF OLD."writerXid" IS NOT NULL OR NEW."writerXid" IS NULL
      OR NEW."writerXid" <> pg_current_xact_id()
      OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
      RAISE EXCEPTION 'Feature generation requires one consistent owning transaction' USING ERRCODE='23514';
    END IF;
    NEW."sourceAsOf" := date_trunc('milliseconds',statement_timestamp());
  ELSIF NEW."sourceAsOf" IS DISTINCT FROM OLD."sourceAsOf" THEN
    RAISE EXCEPTION 'Feature source instant changes only when claiming a build' USING ERRCODE='23514';
  END IF;
  IF NEW.status='READY' THEN
    IF NEW."writerXid" IS DISTINCT FROM pg_current_xact_id()
      OR current_setting('transaction_isolation') NOT IN ('repeatable read','serializable')
      OR NEW."acceptUntil" <= statement_timestamp() OR NEW."epochStart" > statement_timestamp() THEN
      RAISE EXCEPTION 'Unowned or expired feature generation cannot publish' USING ERRCODE='23514';
    END IF;
    SELECT count(*),coalesce(bool_or("sourceComputedAt">NEW."sourceAsOf" OR "sourceAsOf">NEW."sourceAsOf"
      OR "sourceFeatureSchemaVersion"<>NEW."featureSchemaVersion" OR "sourcePolicyVersion"<>NEW."policyVersion"),false)
      INTO copied,invalid_source FROM market_item_feature_snapshots WHERE "epochId"=NEW.id;
    SELECT count(live."productId"),count(frozen."productId")
      INTO expected_rows,matched_rows FROM market_item_features live
      LEFT JOIN market_item_feature_snapshots frozen ON frozen."epochId"=NEW.id
        AND frozen."productId"=live."productId"
      WHERE live."featureSchemaVersion"=NEW."featureSchemaVersion"
        AND live."policyVersion"=NEW."policyVersion";
    IF copied <> NEW."rowCount" OR invalid_source
      OR expected_rows <> copied OR matched_rows <> copied THEN
      RAISE EXCEPTION 'Feature snapshot row count, membership or source lineage is incomplete' USING ERRCODE='23514';
    END IF;
    NEW."readyAt" := date_trunc('milliseconds',statement_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_feature_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON market_feature_epochs
  FOR EACH ROW EXECUTE FUNCTION wiez_market_feature_epoch_guard();

-- One deferred check per manifest update, not one publication query per product.
CREATE FUNCTION wiez_market_feature_build_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_epoch market_feature_epochs%ROWTYPE;
BEGIN
  IF NEW."writerXid" IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO final_epoch FROM market_feature_epochs WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF final_epoch.status='FAILED' AND NOT EXISTS(
    SELECT 1 FROM market_item_feature_snapshots WHERE "epochId"=final_epoch.id) THEN RETURN NULL; END IF;
  IF final_epoch.status<>'READY' OR NOT EXISTS(
    SELECT 1 FROM market_feature_state WHERE key=final_epoch."stateKey"
      AND generation=final_epoch.generation AND "currentEpochId"=final_epoch.id) THEN
    RAISE EXCEPTION 'Feature rows and ready pointer must commit atomically' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_market_feature_build_complete AFTER INSERT OR UPDATE ON market_feature_epochs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wiez_market_feature_build_complete();

-- Transition tables validate the complete batch with joins instead of one
-- parent lookup per copied product.
CREATE FUNCTION wiez_market_snapshot_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  FOR parent IN SELECT e.* FROM market_feature_epochs e
    JOIN (SELECT DISTINCT "epochId" FROM new_feature_rows) n ON n."epochId"=e.id
    ORDER BY e.id FOR SHARE OF e LOOP
    IF parent.status<>'BUILDING' OR parent."writerXid" IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Only the owning build transaction may write snapshots' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN
    IF EXISTS((SELECT "epochId","productId" FROM old_feature_rows)
      EXCEPT (SELECT "epochId","productId" FROM new_feature_rows)) THEN
      RAISE EXCEPTION 'Snapshot product identity cannot change' USING ERRCODE='23514';
    END IF;
    FOR parent IN SELECT e.* FROM market_feature_epochs e
      JOIN (SELECT DISTINCT "epochId" FROM old_feature_rows) n ON n."epochId"=e.id
      ORDER BY e.id FOR SHARE OF e LOOP
      IF parent.status<>'BUILDING' OR parent."writerXid" IS DISTINCT FROM pg_current_xact_id() THEN
        RAISE EXCEPTION 'Published snapshots cannot be moved or rewritten' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_market_snapshot_insert AFTER INSERT ON market_item_feature_snapshots
  REFERENCING NEW TABLE AS new_feature_rows FOR EACH STATEMENT
  EXECUTE FUNCTION wiez_market_snapshot_write_guard();
CREATE TRIGGER trg_market_snapshot_update AFTER UPDATE ON market_item_feature_snapshots
  REFERENCING OLD TABLE AS old_feature_rows NEW TABLE AS new_feature_rows FOR EACH STATEMENT
  EXECUTE FUNCTION wiez_market_snapshot_write_guard();

CREATE FUNCTION wiez_market_snapshot_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM old_feature_rows old_row
    JOIN market_feature_epochs e ON e.id=old_row."epochId"
    JOIN "Product" p ON p."_id"=old_row."productId"
    WHERE e.status='READY' AND (e."cleanupAfter">statement_timestamp()
      OR EXISTS(SELECT 1 FROM market_feature_state s WHERE s."currentEpochId"=e.id))) THEN
    RAISE EXCEPTION 'Retained snapshots may only lose rows through product erasure' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_market_snapshot_delete AFTER DELETE ON market_item_feature_snapshots
  REFERENCING OLD TABLE AS old_feature_rows FOR EACH STATEMENT
  EXECUTE FUNCTION wiez_market_snapshot_delete_guard();


ALTER TABLE market_item_features ADD CONSTRAINT market_item_features_evidence_check CHECK(
  "lowStockVariants">=0
  AND ("minVariantStock" IS NULL OR "minVariantStock">=0)
  AND wiez_market_coverage_valid(coverage)
  AND ("actors7d" IS NULL OR "actors7d">=0)
  AND ("actors28d" IS NULL OR "actors28d">=0)
  AND ("impressions28d" IS NULL OR "impressions28d">=0)
  AND ("units28d" IS NULL OR "units28d">=0)
  AND ("savesCount" IS NULL OR ("savesCount">=0 AND COALESCE(coverage->'savesCount'->>'completeness'='COMPLETE',false)))
  AND ("intent3d" IS NULL OR ("intent3d">=0 AND "intent3d"<'Infinity'::float8))
  AND ("intent28d" IS NULL OR ("intent28d">=0 AND "intent28d"<'Infinity'::float8))
  AND ("decayedPopularity" IS NULL OR ("decayedPopularity">=0 AND "decayedPopularity"<'Infinity'::float8))
  AND ("trendScore" IS NULL OR ("trendScore">'-Infinity'::float8 AND "trendScore"<'Infinity'::float8))
  AND ("qualityScore" IS NULL OR "qualityScore" BETWEEN 0 AND 1)
  AND (NOT "trendEligible" OR ("trendScore" IS NOT NULL AND "actors7d" IS NOT NULL))
  AND ("actors7d" IS NULL OR COALESCE(coverage->'actors7d'->>'completeness'='COMPLETE',false))
  AND ("actors28d" IS NULL OR COALESCE(coverage->'actors28d'->>'completeness'='COMPLETE',false))
  AND ("intent3d" IS NULL OR COALESCE(coverage->'intent3d'->>'completeness'='COMPLETE',false))
  AND ("intent28d" IS NULL OR COALESCE(coverage->'intent28d'->>'completeness'='COMPLETE',false))
  AND ("impressions28d" IS NULL OR COALESCE(coverage->'impressions28d'->>'completeness'='COMPLETE',false))
  AND ("decayedPopularity" IS NULL OR COALESCE(coverage->'decayedPopularity'->>'completeness'='COMPLETE',false))
  AND ("trendScore" IS NULL OR COALESCE(coverage->'trendScore'->>'completeness'='COMPLETE',false))
  AND ("qualityScore" IS NULL OR COALESCE(coverage->'qualityScore'->>'completeness'='COMPLETE',false))
  AND ("units28d" IS NULL OR COALESCE(coverage->'units28d'->>'completeness'='COMPLETE',false)));

ALTER TABLE market_item_feature_snapshots ADD CONSTRAINT market_item_feature_snapshots_evidence_check CHECK(
  "lowStockVariants">=0
  AND ("minVariantStock" IS NULL OR "minVariantStock">=0)
  AND wiez_market_coverage_valid(coverage)
  AND ("actors7d" IS NULL OR "actors7d">=0)
  AND ("actors28d" IS NULL OR "actors28d">=0)
  AND ("impressions28d" IS NULL OR "impressions28d">=0)
  AND ("units28d" IS NULL OR "units28d">=0)
  AND ("savesCount" IS NULL OR ("savesCount">=0 AND COALESCE(coverage->'savesCount'->>'completeness'='COMPLETE',false)))
  AND ("intent3d" IS NULL OR ("intent3d">=0 AND "intent3d"<'Infinity'::float8))
  AND ("intent28d" IS NULL OR ("intent28d">=0 AND "intent28d"<'Infinity'::float8))
  AND ("decayedPopularity" IS NULL OR ("decayedPopularity">=0 AND "decayedPopularity"<'Infinity'::float8))
  AND ("trendScore" IS NULL OR ("trendScore">'-Infinity'::float8 AND "trendScore"<'Infinity'::float8))
  AND ("qualityScore" IS NULL OR "qualityScore" BETWEEN 0 AND 1)
  AND (NOT "trendEligible" OR ("trendScore" IS NOT NULL AND "actors7d" IS NOT NULL))
  AND ("actors7d" IS NULL OR COALESCE(coverage->'actors7d'->>'completeness'='COMPLETE',false))
  AND ("actors28d" IS NULL OR COALESCE(coverage->'actors28d'->>'completeness'='COMPLETE',false))
  AND ("intent3d" IS NULL OR COALESCE(coverage->'intent3d'->>'completeness'='COMPLETE',false))
  AND ("intent28d" IS NULL OR COALESCE(coverage->'intent28d'->>'completeness'='COMPLETE',false))
  AND ("impressions28d" IS NULL OR COALESCE(coverage->'impressions28d'->>'completeness'='COMPLETE',false))
  AND ("decayedPopularity" IS NULL OR COALESCE(coverage->'decayedPopularity'->>'completeness'='COMPLETE',false))
  AND ("trendScore" IS NULL OR COALESCE(coverage->'trendScore'->>'completeness'='COMPLETE',false))
  AND ("qualityScore" IS NULL OR COALESCE(coverage->'qualityScore'->>'completeness'='COMPLETE',false))
  AND ("units28d" IS NULL OR COALESCE(coverage->'units28d'->>'completeness'='COMPLETE',false)));

ALTER TABLE market_item_features ADD CONSTRAINT market_item_features_clock_check
  CHECK("featureSchemaVersion">0 AND "policyVersion">0 AND "sourceAsOf"<="computedAt");
ALTER TABLE market_item_feature_snapshots ADD CONSTRAINT market_snapshot_clock_check
  CHECK("sourceAsOf"<="sourceComputedAt" AND "sourceFeatureSchemaVersion">0 AND "sourcePolicyVersion">0);
ALTER TABLE market_item_features_regional ADD CONSTRAINT market_regional_evidence_check CHECK(
  length(trim(state))>0 AND wiez_market_coverage_valid(coverage)
  AND ("actors28d" IS NULL OR ("actors28d">=0 AND COALESCE(coverage->'actors28d'->>'completeness'='COMPLETE',false)))
  AND ("intent28d" IS NULL OR ("intent28d">=0 AND "intent28d"<'Infinity'::float8
    AND COALESCE(coverage->'intent28d'->>'completeness'='COMPLETE',false))));

COMMIT;
