// Minimal media tables for hand-built catalogue fixtures. The catalogue lists a
// product only when its first usable cover string is an approved, ready image
// file (or a current variant of one). Published fixture products get exactly
// that, derived from their own thumbnail/images; a product without a usable
// cover string gets no media and stays excluded, as it is in production.
const RENDERABLE_COVER_FIXTURE_SQL = `
  CREATE TABLE "FileUpload" (
    "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "s3Url" text NOT NULL,
    "processingStatus" text NOT NULL DEFAULT 'READY', "originalDeletedAt" timestamp,
    "mimeType" text NOT NULL DEFAULT 'image/webp', "assetVersion" integer NOT NULL DEFAULT 1
  );
  CREATE TABLE "FileVariant" ("fileUploadId" uuid REFERENCES "FileUpload", "assetVersion" integer, "s3Url" text);
  CREATE TABLE "ProductMedia" (
    "productId" uuid NOT NULL REFERENCES "Product", "fileUploadId" uuid NOT NULL REFERENCES "FileUpload",
    "reviewStatus" text NOT NULL DEFAULT 'APPROVED'
  );
  CREATE INDEX "ProductMedia_productId_fixture_idx" ON "ProductMedia" ("productId");
  CREATE FUNCTION fixture_renderable_cover() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE cover text; cover_file uuid;
  BEGIN
    cover := COALESCE(
      NULLIF(btrim(NEW.thumbnail), ''),
      (SELECT btrim(value) FROM unnest(NEW.images) WITH ORDINALITY image(value, position)
        WHERE length(btrim(value)) > 0 ORDER BY position LIMIT 1));
    IF cover IS NOT NULL THEN
      INSERT INTO "FileUpload" ("s3Url") VALUES (cover) RETURNING "_id" INTO cover_file;
      INSERT INTO "ProductMedia" ("productId", "fileUploadId") VALUES (NEW."_id", cover_file);
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER fixture_renderable_cover AFTER INSERT ON "Product"
    FOR EACH ROW EXECUTE FUNCTION fixture_renderable_cover();
`;

module.exports = { RENDERABLE_COVER_FIXTURE_SQL };
