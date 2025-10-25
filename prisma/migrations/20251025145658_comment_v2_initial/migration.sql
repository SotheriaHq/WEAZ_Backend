-- CreateEnum
CREATE TYPE "CommentTarget" AS ENUM ('POST', 'COLLECTION', 'COLLECTION_MEDIA');

-- AlterTable
ALTER TABLE "CollectionMedia" ADD COLUMN     "commentsCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "commentsCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CommentV2" (
    "_id" UUID NOT NULL,
    "targetType" "CommentTarget" NOT NULL,
    "targetId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "contentRaw" TEXT NOT NULL,
    "contentSanitized" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CommentV2_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CommentV2Like" (
    "_id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentV2Like_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "CommentV2_targetType_targetId_createdAt_idx" ON "CommentV2"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "CommentV2_parentId_createdAt_idx" ON "CommentV2"("parentId", "createdAt");

-- CreateIndex
CREATE INDEX "CommentV2Like_userId_createdAt_idx" ON "CommentV2Like"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentV2Like_commentId_userId_key" ON "CommentV2Like"("commentId", "userId");

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommentV2"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Like" ADD CONSTRAINT "CommentV2Like_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Like" ADD CONSTRAINT "CommentV2Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
