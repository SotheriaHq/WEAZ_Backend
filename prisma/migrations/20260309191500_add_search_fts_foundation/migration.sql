CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text AS $$
  SELECT public.unaccent('public.unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "brandNameCache" TEXT,
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

ALTER TABLE "Brand"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

ALTER TABLE "Collection"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

ALTER TABLE "StoreCollection"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

UPDATE "Product" p
SET "brandNameCache" = b.name
FROM "Brand" b
WHERE p."brandId" = b."_id"
  AND (p."brandNameCache" IS NULL OR p."brandNameCache" <> b.name);

CREATE OR REPLACE FUNCTION product_search_vector_update()
RETURNS trigger AS $$
BEGIN
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.name, ''))), 'A')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.description, ''))), 'B')
      || setweight(to_tsvector('english', immutable_unaccent(array_to_string(COALESCE(NEW.tags, ARRAY[]::text[]), ' '))), 'B')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW."brandNameCache", ''))), 'C')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.materials, ''))), 'D');
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector := to_tsvector('english', '');
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_search_vector ON "Product";
CREATE TRIGGER trg_product_search_vector
BEFORE INSERT OR UPDATE OF name, description, tags, materials, "brandNameCache"
ON "Product"
FOR EACH ROW
EXECUTE FUNCTION product_search_vector_update();

CREATE OR REPLACE FUNCTION brand_search_vector_update()
RETURNS trigger AS $$
BEGIN
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.name, ''))), 'A')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.description, ''))), 'B')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.tagline, ''))), 'B')
      || setweight(to_tsvector('english', immutable_unaccent(array_to_string(COALESCE(NEW.tags, ARRAY[]::text[]), ' '))), 'C');
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector := to_tsvector('english', '');
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_brand_search_vector ON "Brand";
CREATE TRIGGER trg_brand_search_vector
BEFORE INSERT OR UPDATE OF name, description, tagline, tags
ON "Brand"
FOR EACH ROW
EXECUTE FUNCTION brand_search_vector_update();

CREATE OR REPLACE FUNCTION collection_search_vector_update()
RETURNS trigger AS $$
BEGIN
  BEGIN
    NEW.search_vector :=
      setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.title, ''))), 'A')
      || setweight(to_tsvector('english', immutable_unaccent(COALESCE(NEW.description, ''))), 'B')
      || setweight(to_tsvector('english', immutable_unaccent(array_to_string(COALESCE(NEW.tags, ARRAY[]::text[]), ' '))), 'B');
  EXCEPTION WHEN OTHERS THEN
    NEW.search_vector := to_tsvector('english', '');
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_collection_search_vector ON "Collection";
CREATE TRIGGER trg_collection_search_vector
BEFORE INSERT OR UPDATE OF title, description, tags
ON "Collection"
FOR EACH ROW
EXECUTE FUNCTION collection_search_vector_update();

DROP TRIGGER IF EXISTS trg_store_collection_search_vector ON "StoreCollection";
CREATE TRIGGER trg_store_collection_search_vector
BEFORE INSERT OR UPDATE OF title, description, tags
ON "StoreCollection"
FOR EACH ROW
EXECUTE FUNCTION collection_search_vector_update();

UPDATE "Product" SET name = name;
UPDATE "Brand" SET name = name;
UPDATE "Collection" SET title = title;
UPDATE "StoreCollection" SET title = title;

CREATE INDEX IF NOT EXISTS idx_product_search_vector
  ON "Product" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS idx_product_name_trgm
  ON "Product" USING GIN (immutable_unaccent(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_product_brand_name_cache_trgm
  ON "Product" USING GIN (immutable_unaccent(COALESCE("brandNameCache", '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_brand_search_vector
  ON "Brand" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS idx_brand_name_trgm
  ON "Brand" USING GIN (immutable_unaccent(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_collection_search_vector
  ON "Collection" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS idx_collection_title_trgm
  ON "Collection" USING GIN (immutable_unaccent(COALESCE(title, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_store_collection_search_vector
  ON "StoreCollection" USING GIN ("search_vector");

CREATE INDEX IF NOT EXISTS idx_store_collection_title_trgm
  ON "StoreCollection" USING GIN (immutable_unaccent(COALESCE(title, '')) gin_trgm_ops);