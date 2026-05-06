CREATE TYPE "BrandMemberRole" AS ENUM (
  'OWNER',
  'MANAGER',
  'CATALOG_MANAGER',
  'ORDER_MANAGER',
  'SUPPORT_AGENT',
  'VIEWER'
);

CREATE TYPE "BrandMemberStatus" AS ENUM (
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED'
);

CREATE TABLE "BrandMember" (
  "id" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "BrandMemberRole" NOT NULL,
  "status" "BrandMemberStatus" NOT NULL DEFAULT 'ACTIVE',
  "invitedById" UUID,
  "joinedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BrandMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandPermissionGrant" (
  "id" UUID NOT NULL,
  "brandMemberId" UUID NOT NULL,
  "permissionCode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BrandPermissionGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrandMember_brandId_userId_key" ON "BrandMember"("brandId", "userId");
CREATE INDEX "BrandMember_userId_idx" ON "BrandMember"("userId");
CREATE INDEX "BrandMember_brandId_idx" ON "BrandMember"("brandId");
CREATE INDEX "BrandMember_status_idx" ON "BrandMember"("status");
CREATE INDEX "BrandMember_role_idx" ON "BrandMember"("role");

CREATE UNIQUE INDEX "BrandPermissionGrant_brandMemberId_permissionCode_key"
  ON "BrandPermissionGrant"("brandMemberId", "permissionCode");
CREATE INDEX "BrandPermissionGrant_brandMemberId_idx" ON "BrandPermissionGrant"("brandMemberId");

ALTER TABLE "BrandMember"
ADD CONSTRAINT "BrandMember_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandMember"
ADD CONSTRAINT "BrandMember_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandPermissionGrant"
ADD CONSTRAINT "BrandPermissionGrant_brandMemberId_fkey"
FOREIGN KEY ("brandMemberId") REFERENCES "BrandMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
