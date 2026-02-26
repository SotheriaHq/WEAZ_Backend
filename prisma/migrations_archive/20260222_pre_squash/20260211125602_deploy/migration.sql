/*
  Warnings:

  - The values [LIKE] on the enum `NotificationType` will be removed. If these variants are still used in the database, this will fail.
  - The values [LIKE] on the enum `ReactionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('SIGNUP', 'LOGIN', 'COLLECTION_UPLOAD', 'PRODUCT_UPLOAD', 'COLLECTION_DELETED', 'THREAD', 'COMMENT', 'PATCH', 'FOLLOW', 'LOGOUT', 'LOGOUT_ALL', 'PRIVATE_ACCESS_REQUESTED', 'PRIVATE_ACCESS_APPROVED', 'PRIVATE_ACCESS_REJECTED', 'PRIVATE_ACCESS_REVOKED', 'BRAND_PATCH_REQUEST', 'BRAND_PATCH_ACCEPTED', 'BRAND_PATCH_REJECTED', 'ORDER_PLACED', 'ORDER_STATUS_UPDATED', 'CONTRIBUTION_REQUEST', 'CONTRIBUTION_ACCEPTED', 'CONTRIBUTION_REJECTED');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "public"."NotificationType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ReactionType_new" AS ENUM ('THREAD', 'DISLIKE');
ALTER TABLE "CollectionReaction" ALTER COLUMN "type" TYPE "ReactionType_new" USING ("type"::text::"ReactionType_new");
ALTER TABLE "CommentReaction" ALTER COLUMN "type" TYPE "ReactionType_new" USING ("type"::text::"ReactionType_new");
ALTER TABLE "CollectionMediaReaction" ALTER COLUMN "type" TYPE "ReactionType_new" USING ("type"::text::"ReactionType_new");
ALTER TYPE "ReactionType" RENAME TO "ReactionType_old";
ALTER TYPE "ReactionType_new" RENAME TO "ReactionType";
DROP TYPE "public"."ReactionType_old";
COMMIT;

-- CreateTable
CREATE TABLE "SystemTag" (
    "_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemTag_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemTag_tag_key" ON "SystemTag"("tag");

-- CreateIndex
CREATE INDEX "SystemTag_tag_idx" ON "SystemTag"("tag");
