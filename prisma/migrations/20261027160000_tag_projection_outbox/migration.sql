-- Additive projection recovery. Binary rollback may leave the queues/triggers in place.
-- These tables are internal instructions, not domain ownership relations.
CREATE TABLE "TagProjectionOutbox" (
  "entityType" "TagEntityType" NOT NULL, "entityId" UUID NOT NULL, "generation" UUID NOT NULL DEFAULT gen_random_uuid(),
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3), "lockOwner" UUID, "lockExpiresAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("entityType","entityId"),
  CONSTRAINT "TagProjectionOutbox_state" CHECK ("status" IN ('PENDING','PROCESSING','FAILED') AND "attempts">=0),
  CONSTRAINT "TagProjectionOutbox_lease" CHECK (
    ("status"='PROCESSING' AND "lockedAt" IS NOT NULL AND "lockOwner" IS NOT NULL AND "lockExpiresAt" IS NOT NULL)
    OR ("status"<>'PROCESSING' AND "lockedAt" IS NULL AND "lockOwner" IS NULL AND "lockExpiresAt" IS NULL))
);
CREATE INDEX "TagProjectionOutbox_status_availableAt_idx" ON "TagProjectionOutbox"("status","availableAt");
CREATE INDEX "TagProjectionOutbox_status_lockExpiresAt_idx" ON "TagProjectionOutbox"("status","lockExpiresAt");

CREATE TABLE "TagUsageOutbox" (
  "tagId" UUID NOT NULL, "generation" UUID NOT NULL DEFAULT gen_random_uuid(),
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3), "lockOwner" UUID, "lockExpiresAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tagId"),
  CONSTRAINT "TagUsageOutbox_state" CHECK ("status" IN ('PENDING','PROCESSING','FAILED') AND "attempts">=0),
  CONSTRAINT "TagUsageOutbox_lease" CHECK (
    ("status"='PROCESSING' AND "lockedAt" IS NOT NULL AND "lockOwner" IS NOT NULL AND "lockExpiresAt" IS NOT NULL)
    OR ("status"<>'PROCESSING' AND "lockedAt" IS NULL AND "lockOwner" IS NULL AND "lockExpiresAt" IS NULL))
);
CREATE INDEX "TagUsageOutbox_status_availableAt_idx" ON "TagUsageOutbox"("status","availableAt");
CREATE INDEX "TagUsageOutbox_status_lockExpiresAt_idx" ON "TagUsageOutbox"("status","lockExpiresAt");

-- No source/tag FK: delete instructions must survive their original rows.
CREATE FUNCTION enqueue_tag_projection(kind "TagEntityType", target UUID) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "TagProjectionOutbox"("entityType","entityId","generation","availableAt","updatedAt")
  VALUES(kind,target,gen_random_uuid(),clock_timestamp() AT TIME ZONE 'UTC',clock_timestamp() AT TIME ZONE 'UTC')
  ON CONFLICT("entityType","entityId") DO UPDATE SET
    "generation"=gen_random_uuid(),"status"='PENDING',"attempts"=0,
    "availableAt"=clock_timestamp() AT TIME ZONE 'UTC',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC',
    "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"lastError"=NULL;
$$;

CREATE FUNCTION source_tag_projection_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous JSONB; current JSONB; field TEXT; changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN current:=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' THEN
    FOREACH field IN ARRAY TG_ARGV[1:] LOOP
      IF previous->field IS DISTINCT FROM current->field THEN changed:=TRUE; EXIT; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  IF TG_TABLE_NAME='User' AND COALESCE(previous->>'type','')<>'BRAND' AND COALESCE(current->>'type','')<>'BRAND' THEN RETURN NULL; END IF;
  PERFORM enqueue_tag_projection(TG_ARGV[0]::"TagEntityType",COALESCE(current->>'_id',previous->>'_id')::uuid);
  IF TG_TABLE_NAME='Brand' THEN
    PERFORM enqueue_tag_projection('USER_BRAND',COALESCE(current->>'ownerId',previous->>'ownerId')::uuid);
    IF TG_OP='UPDATE' AND previous->>'ownerId' IS DISTINCT FROM current->>'ownerId' THEN
      PERFORM enqueue_tag_projection('USER_BRAND',(previous->>'ownerId')::uuid);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "Collection_tag_projection_insert" AFTER INSERT ON "Collection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "Collection_tag_projection_update" AFTER UPDATE OF "tags","status","visibility","deletedAt" ON "Collection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "Collection_tag_projection_delete" AFTER DELETE ON "Collection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "StoreCollection_tag_projection_insert" AFTER INSERT ON "StoreCollection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('STORE_COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "StoreCollection_tag_projection_update" AFTER UPDATE OF "tags","status","visibility","deletedAt" ON "StoreCollection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('STORE_COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "StoreCollection_tag_projection_delete" AFTER DELETE ON "StoreCollection" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('STORE_COLLECTION','tags','status','visibility','deletedAt');

CREATE TRIGGER "Product_tag_projection_insert" AFTER INSERT ON "Product" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('PRODUCT','tags','isActive','deletedAt','archivedAt','publishAt');

CREATE TRIGGER "Product_tag_projection_update" AFTER UPDATE OF "tags","isActive","deletedAt","archivedAt","publishAt" ON "Product" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('PRODUCT','tags','isActive','deletedAt','archivedAt','publishAt');

CREATE TRIGGER "Product_tag_projection_delete" AFTER DELETE ON "Product" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('PRODUCT','tags','isActive','deletedAt','archivedAt','publishAt');

CREATE TRIGGER "Brand_tag_projection_insert" AFTER INSERT ON "Brand" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('BRAND','tags','isStoreOpen','ownerId');

CREATE TRIGGER "Brand_tag_projection_update" AFTER UPDATE OF "tags","isStoreOpen","ownerId" ON "Brand" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('BRAND','tags','isStoreOpen','ownerId');

CREATE TRIGGER "Brand_tag_projection_delete" AFTER DELETE ON "Brand" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('BRAND','tags','isStoreOpen','ownerId');

CREATE TRIGGER "User_tag_projection_insert" AFTER INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('USER_BRAND','type');

CREATE TRIGGER "User_tag_projection_update" AFTER UPDATE OF "type" ON "User" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('USER_BRAND','type');

CREATE TRIGGER "User_tag_projection_delete" AFTER DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION source_tag_projection_changed('USER_BRAND','type');

CREATE FUNCTION tag_usage_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "TagUsageOutbox"("tagId","generation","availableAt","updatedAt")
  SELECT affected."tagId",gen_random_uuid(),clock_timestamp() AT TIME ZONE 'UTC',clock_timestamp() AT TIME ZONE 'UTC'
  FROM (SELECT DISTINCT "tagId" FROM inserted) affected ORDER BY affected."tagId"
  ON CONFLICT("tagId") DO UPDATE SET "generation"=gen_random_uuid(),"status"='PENDING',"attempts"=0,
    "availableAt"=clock_timestamp() AT TIME ZONE 'UTC',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC',
    "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"lastError"=NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER "TagBinding_usage_insert" AFTER INSERT ON "TagBinding"
  REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION tag_usage_after_insert();

CREATE FUNCTION tag_usage_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "TagUsageOutbox"("tagId","generation","availableAt","updatedAt")
  SELECT affected."tagId",gen_random_uuid(),clock_timestamp() AT TIME ZONE 'UTC',clock_timestamp() AT TIME ZONE 'UTC'
  FROM (SELECT DISTINCT "tagId" FROM deleted) affected ORDER BY affected."tagId"
  ON CONFLICT("tagId") DO UPDATE SET "generation"=gen_random_uuid(),"status"='PENDING',"attempts"=0,
    "availableAt"=clock_timestamp() AT TIME ZONE 'UTC',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC',
    "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"lastError"=NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER "TagBinding_usage_delete" AFTER DELETE ON "TagBinding"
  REFERENCING OLD TABLE AS deleted FOR EACH STATEMENT EXECUTE FUNCTION tag_usage_after_delete();

CREATE FUNCTION tag_usage_after_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "TagUsageOutbox"("tagId","generation","availableAt","updatedAt")
  SELECT affected."tagId",gen_random_uuid(),clock_timestamp() AT TIME ZONE 'UTC',clock_timestamp() AT TIME ZONE 'UTC'
  FROM (SELECT "tagId" FROM inserted UNION SELECT "tagId" FROM deleted) affected ORDER BY affected."tagId"
  ON CONFLICT("tagId") DO UPDATE SET "generation"=gen_random_uuid(),"status"='PENDING',"attempts"=0,
    "availableAt"=clock_timestamp() AT TIME ZONE 'UTC',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC',
    "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"lastError"=NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER "TagBinding_usage_update" AFTER UPDATE ON "TagBinding"
  REFERENCING OLD TABLE AS deleted NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION tag_usage_after_update();
