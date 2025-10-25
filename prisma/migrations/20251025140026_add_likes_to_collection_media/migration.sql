/*
  Warnings:

  - A unique constraint covering the columns `[clientEventId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ContentTarget" AS ENUM ('POST', 'COLLECTION');

-- AlterTable
ALTER TABLE "CollectionMedia" ADD COLUMN     "likesCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CollectionReaction" ADD COLUMN     "clientEventId" TEXT;

-- AlterTable
ALTER TABLE "Like" ADD COLUMN     "clientEventId" TEXT;

-- CreateTable
CREATE TABLE "DailyLikeAggregate" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentType" "ContentTarget" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyLikeAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuarantinedLike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentType" "ContentTarget" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuarantinedLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionMediaReaction" (
    "_id" UUID NOT NULL,
    "collectionMediaId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ReactionType" NOT NULL,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionMediaReaction_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "DailyLikeAggregate_contentType_contentId_idx" ON "DailyLikeAggregate"("contentType", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLikeAggregate_contentType_contentId_date_key" ON "DailyLikeAggregate"("contentType", "contentId", "date");

-- CreateIndex
CREATE INDEX "QuarantinedLike_userId_contentType_contentId_idx" ON "QuarantinedLike"("userId", "contentType", "contentId");

-- CreateIndex
CREATE INDEX "CollectionMediaReaction_collectionMediaId_idx" ON "CollectionMediaReaction"("collectionMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMediaReaction_collectionMediaId_userId_key" ON "CollectionMediaReaction"("collectionMediaId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_clientEventId_key" ON "Like"("clientEventId");

-- AddForeignKey
ALTER TABLE "CollectionMediaReaction" ADD CONSTRAINT "CollectionMediaReaction_collectionMediaId_fkey" FOREIGN KEY ("collectionMediaId") REFERENCES "CollectionMedia"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMediaReaction" ADD CONSTRAINT "CollectionMediaReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
