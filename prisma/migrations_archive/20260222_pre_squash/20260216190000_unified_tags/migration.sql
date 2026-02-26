-- CreateEnum
CREATE TYPE "TagEntityType" AS ENUM ('COLLECTION', 'PRODUCT', 'BRAND', 'USER_BRAND');

-- CreateTable
CREATE TABLE "Tag" (
    "_id" UUID NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "aliasOfTagId" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "TagBinding" (
    "_id" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "entityType" "TagEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagBinding_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_normalizedName_key" ON "Tag"("normalizedName");

-- CreateIndex
CREATE INDEX "Tag_usageCount_updatedAt_idx" ON "Tag"("usageCount" DESC, "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Tag_isBanned_usageCount_idx" ON "Tag"("isBanned", "usageCount" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TagBinding_tagId_entityType_entityId_key" ON "TagBinding"("tagId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "TagBinding_entityType_entityId_idx" ON "TagBinding"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "TagBinding_tagId_createdAt_idx" ON "TagBinding"("tagId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_aliasOfTagId_fkey" FOREIGN KEY ("aliasOfTagId") REFERENCES "Tag"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagBinding" ADD CONSTRAINT "TagBinding_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
