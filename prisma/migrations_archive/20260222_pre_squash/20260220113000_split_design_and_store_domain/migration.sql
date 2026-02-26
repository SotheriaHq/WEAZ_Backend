DO $$
BEGIN
  CREATE TYPE "CollectionDomain" AS ENUM ('DESIGN', 'STORE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Collection"
ADD COLUMN IF NOT EXISTS "domain" "CollectionDomain";

UPDATE "Collection" AS c
SET "domain" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "CollectionMedia" AS m
    WHERE m."collectionId" = c."_id"
  ) THEN 'DESIGN'::"CollectionDomain"
  WHEN EXISTS (
    SELECT 1
    FROM "CollectionProduct" AS cp
    WHERE cp."collectionId" = c."_id"
  ) THEN 'STORE'::"CollectionDomain"
  WHEN c."isAvailableInStore" THEN 'STORE'::"CollectionDomain"
  ELSE 'DESIGN'::"CollectionDomain"
END
WHERE c."domain" IS NULL;

ALTER TABLE "Collection"
ALTER COLUMN "domain" SET DEFAULT 'DESIGN'::"CollectionDomain";

ALTER TABLE "Collection"
ALTER COLUMN "domain" SET NOT NULL;

UPDATE "Collection"
SET "isAvailableInStore" = CASE
  WHEN "domain" = 'STORE'::"CollectionDomain" THEN TRUE
  ELSE FALSE
END
WHERE "isAvailableInStore" IS DISTINCT FROM CASE
  WHEN "domain" = 'STORE'::"CollectionDomain" THEN TRUE
  ELSE FALSE
END;

ALTER TABLE "Collection"
DROP CONSTRAINT IF EXISTS "Collection_domain_store_flag_check";

ALTER TABLE "Collection"
ADD CONSTRAINT "Collection_domain_store_flag_check"
CHECK (
  ("domain" = 'DESIGN'::"CollectionDomain" AND "isAvailableInStore" = FALSE)
  OR ("domain" = 'STORE'::"CollectionDomain" AND "isAvailableInStore" = TRUE)
);

CREATE INDEX IF NOT EXISTS "Collection_ownerId_domain_status_createdAt_idx"
ON "Collection"("ownerId", "domain", "status", "createdAt");
