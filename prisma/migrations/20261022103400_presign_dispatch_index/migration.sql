CREATE INDEX CONCURRENTLY "PresignedUpload_pending_processing_idx" ON "PresignedUpload"("createdAt", "_id")
WHERE status = 'USED' AND "processingEnqueuedAt" IS NULL AND "processingRequestedAt" IS NOT NULL;
