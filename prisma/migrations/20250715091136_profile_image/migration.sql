-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SuperAdmin', 'Admin', 'User');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('BRAND', 'REGULAR');

-- CreateTable
CREATE TABLE "User" (
    "_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'User',
    "type" "UserType" NOT NULL DEFAULT 'REGULAR',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "address" TEXT,
    "brandFullName" TEXT,
    "cacNumber" TEXT,
    "tin" TEXT,
    "ceoNin" TEXT,
    "ceoFirstName" TEXT,
    "ceoLastName" TEXT,
    "companyLocation" TEXT,
    "profileImage" TEXT,
    "industriNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_cacNumber_key" ON "User"("cacNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_tin_key" ON "User"("tin");

-- CreateIndex
CREATE UNIQUE INDEX "User_ceoNin_key" ON "User"("ceoNin");

-- CreateIndex
CREATE UNIQUE INDEX "User_industriNumber_key" ON "User"("industriNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
