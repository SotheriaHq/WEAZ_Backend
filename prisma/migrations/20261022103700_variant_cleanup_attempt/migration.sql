ALTER TABLE "StorageObjectDeletion"
  ADD COLUMN "processingFileId" UUID,
  ADD COLUMN "processingLeaseToken" UUID;
