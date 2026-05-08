-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_bannerImageId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_profileImageId_fkey";

-- DropIndex
DROP INDEX "User_cacNumber_key";

-- DropIndex
DROP INDEX "User_ceoNin_key";

-- DropIndex
DROP INDEX "User_industriNumber_key";

-- DropIndex
DROP INDEX "User_tin_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "address",
DROP COLUMN "bannerImage",
DROP COLUMN "bannerImageId",
DROP COLUMN "brandBusinessType",
DROP COLUMN "brandCity",
DROP COLUMN "brandCountry",
DROP COLUMN "brandDescription",
DROP COLUMN "brandFullName",
DROP COLUMN "brandState",
DROP COLUMN "brandTags",
DROP COLUMN "cacNumber",
DROP COLUMN "ceoFirstName",
DROP COLUMN "ceoLastName",
DROP COLUMN "ceoNin",
DROP COLUMN "companyLocation",
DROP COLUMN "firstName",
DROP COLUMN "industriNumber",
DROP COLUMN "lastName",
DROP COLUMN "phoneNumber",
DROP COLUMN "profileImage",
DROP COLUMN "profileImageId",
DROP COLUMN "profileVisibility",
DROP COLUMN "socialFacebook",
DROP COLUMN "socialInstagram",
DROP COLUMN "socialTwitter",
DROP COLUMN "socialWebsite",
DROP COLUMN "tin";
