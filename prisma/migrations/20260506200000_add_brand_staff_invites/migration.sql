-- CreateEnum
CREATE TYPE "BrandStaffInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BrandStaffInvite" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "BrandMemberRole" NOT NULL,
    "status" "BrandStaffInviteStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "invitedUserId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandStaffInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrandStaffInvite_tokenHash_key" ON "BrandStaffInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_brandId_idx" ON "BrandStaffInvite"("brandId");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_email_idx" ON "BrandStaffInvite"("email");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_status_idx" ON "BrandStaffInvite"("status");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_invitedById_idx" ON "BrandStaffInvite"("invitedById");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_invitedUserId_idx" ON "BrandStaffInvite"("invitedUserId");

-- CreateIndex
CREATE INDEX "BrandStaffInvite_expiresAt_idx" ON "BrandStaffInvite"("expiresAt");

-- AddForeignKey
ALTER TABLE "BrandStaffInvite" ADD CONSTRAINT "BrandStaffInvite_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
