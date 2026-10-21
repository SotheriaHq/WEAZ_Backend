BEGIN;
ALTER TABLE "FileUpload" ADD COLUMN "processingLeaseToken" UUID;
ALTER TABLE "FileUpload" ADD COLUMN "processingLeaseUntil" TIMESTAMP(3);
ALTER TABLE "FileUpload" ADD CONSTRAINT "FileUpload_processing_lease_check" CHECK (("processingLeaseToken" IS NULL) = ("processingLeaseUntil" IS NULL));
COMMIT;
