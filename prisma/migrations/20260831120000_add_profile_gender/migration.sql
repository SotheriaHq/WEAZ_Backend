-- CreateEnum
CREATE TYPE "ProfileGender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'UNSPECIFIED');

-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN "gender" "ProfileGender";
