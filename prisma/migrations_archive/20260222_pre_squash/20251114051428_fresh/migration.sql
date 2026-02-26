-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "saleEndAt" TIMESTAMP(3),
ADD COLUMN     "saleMaxPrice" DOUBLE PRECISION,
ADD COLUMN     "saleMinPrice" DOUBLE PRECISION,
ADD COLUMN     "saleStartAt" TIMESTAMP(3);
