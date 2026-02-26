/*
  Warnings:

  - A unique constraint covering the columns `[requesterId,collectionId]` on the table `ContributionRequest` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ContributionRequest_requesterId_collectionId_key" ON "ContributionRequest"("requesterId", "collectionId");
