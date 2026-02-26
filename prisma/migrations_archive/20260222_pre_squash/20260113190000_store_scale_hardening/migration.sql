-- Search-at-scale: enable trigram indexing for fast ILIKE/contains queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Product name/description trigram indexes (helps Prisma `contains`/ILIKE)
CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING GIN ("description" gin_trgm_ops);

-- Filter-at-scale: GIN for array filters
CREATE INDEX IF NOT EXISTS "Product_tags_gin_idx" ON "Product" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "Product_sizes_gin_idx" ON "Product" USING GIN ("sizes");
CREATE INDEX IF NOT EXISTS "Product_colors_gin_idx" ON "Product" USING GIN ("colors");
