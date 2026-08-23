-- Product media has always been admitted by the endpoint's 8MB Multer cap,
-- but UploadService subsequently read the unrelated 2MB POST_IMAGE setting.
-- Update only the legacy default so a deliberately stricter administrator
-- override is not overwritten on deployment.
UPDATE "system_config"
SET "value" = '8388608'
WHERE "key" = 'upload.maxSize.productMedia'
  AND "value" = '2097152';
