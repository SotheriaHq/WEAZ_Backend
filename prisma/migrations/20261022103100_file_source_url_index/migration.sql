-- Keep this migration outside an explicit transaction: existing media tables can be large.
CREATE INDEX CONCURRENTLY "FileUpload_s3Url_idx" ON "FileUpload"("s3Url");
