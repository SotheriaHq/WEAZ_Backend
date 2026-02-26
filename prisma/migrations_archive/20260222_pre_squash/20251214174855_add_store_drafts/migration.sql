-- CreateEnum
CREATE TYPE "StoreDraftStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'COMPLETED');

-- CreateTable
CREATE TABLE "StoreDraft" (
    "_id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "lastStep" INTEGER NOT NULL DEFAULT 1,
    "status" "StoreDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreDraft_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreDraft_ownerId_key" ON "StoreDraft"("ownerId");

-- AddForeignKey
ALTER TABLE "StoreDraft" ADD CONSTRAINT "StoreDraft_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
