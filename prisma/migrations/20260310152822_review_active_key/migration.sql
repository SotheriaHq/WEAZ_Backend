/*
  Warnings:

  - A unique constraint covering the columns `[userId,productId,activeReviewKey]` on the table `ProductReview` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "ProductReview" ADD COLUMN     "activeReviewKey" TEXT DEFAULT 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_userId_productId_activeReviewKey_key" ON "ProductReview"("userId", "productId", "activeReviewKey");
