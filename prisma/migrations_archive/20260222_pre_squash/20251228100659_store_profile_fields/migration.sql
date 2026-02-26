/*
  Warnings:

  - You are about to drop the `StoreDraft` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "StoreDraft" DROP CONSTRAINT "StoreDraft_ownerId_fkey";

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "socialInstagram" TEXT,
ADD COLUMN     "socialTiktok" TEXT,
ADD COLUMN     "socialTwitter" TEXT,
ADD COLUMN     "socialWebsite" TEXT,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- DropTable
DROP TABLE "StoreDraft";

-- DropEnum
DROP TYPE "StoreDraftStatus";
