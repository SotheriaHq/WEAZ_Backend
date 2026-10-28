BEGIN;
ALTER TABLE "CollectionCategorySuggestion"
  ADD COLUMN "garmentTypeName" text,
  ADD COLUMN "garmentTypeSlug" text NOT NULL DEFAULT '',
  ADD COLUMN "approvedCategoryTypeId" uuid;
DROP INDEX "CollectionCategorySuggestion_slug_key";
CREATE UNIQUE INDEX "CollectionCategorySuggestion_slug_garmentTypeSlug_key"
  ON "CollectionCategorySuggestion"(slug,"garmentTypeSlug");
CREATE UNIQUE INDEX "CollectionCategoryType_id_categoryId_key" ON "CollectionCategoryType"("_id","categoryId");
ALTER TABLE "CollectionCategorySuggestion"
  ADD CONSTRAINT "CollectionCategorySuggestion_approved_type_fkey"
  FOREIGN KEY("approvedCategoryTypeId","approvedCategoryId") REFERENCES "CollectionCategoryType"("_id","categoryId")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "CollectionCategorySuggestion_garment_pair" CHECK (
    ("garmentTypeName" IS NULL AND "garmentTypeSlug"='' AND "approvedCategoryTypeId" IS NULL)
    OR ("garmentTypeName" IS NOT NULL AND length(btrim("garmentTypeName")) BETWEEN 2 AND 48 AND length("garmentTypeSlug")>0)
  ),
  ADD CONSTRAINT "CollectionCategorySuggestion_approved_pair" CHECK (
    status<>'APPROVED' OR ("approvedCategoryId" IS NOT NULL AND ("garmentTypeName" IS NULL OR "approvedCategoryTypeId" IS NOT NULL))
  );
COMMIT;
