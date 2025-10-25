-- AlterTable
ALTER TABLE "User" ADD COLUMN     "brandBusinessType" TEXT,
ADD COLUMN     "brandCity" TEXT,
ADD COLUMN     "brandCountry" TEXT,
ADD COLUMN     "brandDescription" TEXT,
ADD COLUMN     "brandState" TEXT,
ADD COLUMN     "brandTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "socialFacebook" TEXT,
ADD COLUMN     "socialInstagram" TEXT,
ADD COLUMN     "socialTwitter" TEXT,
ADD COLUMN     "socialWebsite" TEXT;
