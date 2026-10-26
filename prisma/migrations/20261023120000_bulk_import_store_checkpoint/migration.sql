-- Fresh-regression contraction: no reinterpretation/deletion of design import jobs.
-- Existing incompatible jobs require the owner-authorized reset before this migration.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "CollectionBulkUploadJob" j LEFT JOIN "StoreCollection" c ON c."_id" = j."collectionId" WHERE c."_id" IS NULL) THEN
    RAISE EXCEPTION 'Bulk product imports must reference StoreCollection; run the authorized fresh-regression reset before this contraction';
  END IF;
END $$;
ALTER TABLE "CollectionBulkUploadJob" DROP CONSTRAINT "CollectionBulkUploadJob_collectionId_fkey";
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionBulkUploadJob" ADD COLUMN "processingToken" UUID, ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_lease_pair" CHECK (("processingToken" IS NULL) = ("leaseExpiresAt" IS NULL));
ALTER TABLE "CollectionBulkUploadRow" ADD COLUMN "productCreatedAt" TIMESTAMP(3);
ALTER TABLE "CollectionBulkUploadRow" ADD CONSTRAINT "CollectionBulkUploadRow_committed_product" CHECK ("createdProductId" IS NULL OR "productCreatedAt" IS NOT NULL);
ALTER TABLE "CollectionBulkUploadRow" ALTER COLUMN "createdProductId" TYPE UUID USING "createdProductId"::uuid;
CREATE UNIQUE INDEX "CollectionBulkUploadRow_createdProductId_key" ON "CollectionBulkUploadRow"("createdProductId");
ALTER TABLE "CollectionBulkUploadRow" ADD CONSTRAINT "CollectionBulkUploadRow_createdProductId_fkey" FOREIGN KEY ("createdProductId") REFERENCES "Product"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
