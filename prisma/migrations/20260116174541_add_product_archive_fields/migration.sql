-- DropIndex
DROP INDEX "Product_colors_gin_idx";

-- DropIndex
DROP INDEX "Product_description_trgm_idx";

-- DropIndex
DROP INDEX "Product_name_trgm_idx";

-- DropIndex
DROP INDEX "Product_sizes_gin_idx";

-- DropIndex
DROP INDEX "Product_tags_gin_idx";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "archiveExpiresAt" TIMESTAMP(3),
ADD COLUMN     "archiveLastReminder" TIMESTAMP(3),
ADD COLUMN     "archivedAt" TIMESTAMP(3);
