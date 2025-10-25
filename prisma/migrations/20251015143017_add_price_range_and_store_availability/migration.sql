-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "isAvailableInStore" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxPrice" DOUBLE PRECISION,
ADD COLUMN     "minPrice" DOUBLE PRECISION;
