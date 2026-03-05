-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AdminAuditAction" AS ENUM ('ADMIN_USER_CREATE', 'ADMIN_USER_ROLE_UPDATE', 'ADMIN_USER_PERMISSION_UPDATE', 'ADMIN_USER_STATUS_UPDATE', 'ADMIN_USER_FORCE_PASSWORD_RESET', 'ADMIN_BRAND_VERIFY', 'ADMIN_BRAND_SUSPEND', 'ADMIN_BRAND_STORE_OVERRIDE', 'ADMIN_PRODUCT_MODERATE', 'ADMIN_COLLECTION_MODERATE', 'ADMIN_MODERATION_QUARANTINE', 'ADMIN_MODERATION_BULK_REMOVE', 'ADMIN_MODERATION_ITEM_UPDATE', 'ADMIN_TAXONOMY_WRITE', 'ADMIN_TAXONOMY_SUGGESTION_MODERATE', 'ADMIN_TAG_MODERATE', 'ADMIN_MEASUREMENT_REVIEW', 'ADMIN_PAYOUT_STATUS_UPDATE', 'ADMIN_DISPUTE_RESOLVE', 'ADMIN_DISPUTE_REOPEN', 'ADMIN_DISPUTE_CREATE', 'ADMIN_SLA_CREATE', 'ADMIN_SLA_UPDATE', 'ADMIN_SLA_DELETE', 'ADMIN_NOTIFICATION_SEND', 'ADMIN_FEATURE_FLAG_TOGGLE', 'ADMIN_SYSTEM_SETTINGS_UPDATE', 'ADMIN_BREAK_GLASS_SUCCESS', 'ADMIN_BREAK_GLASS_FAILURE');

-- CreateEnum
CREATE TYPE "DisputeType" AS ENUM ('ORDER', 'PRODUCT', 'SIZING', 'GENERAL');

-- CreateEnum
CREATE TYPE "AdminDisputeStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_ACTION';

-- DropIndex
DROP INDEX "MeasurementPoint_label_trgm_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "adminSuspendedAt" TIMESTAMP(3),
ADD COLUMN     "adminSuspendedReason" TEXT,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedReason" TEXT,
ADD COLUMN     "mustResetPassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "AdminPermissionGrant" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "permissionCode" TEXT NOT NULL,
    "grantedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminPermissionGrant_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "_id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "action" "AdminAuditAction" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "previousState" JSONB,
    "newState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "BreakGlassCode" (
    "_id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakGlassCode_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "AdminSlaConfig" (
    "_id" UUID NOT NULL,
    "area" TEXT NOT NULL,
    "targetHours" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminSlaConfig_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "AdminNotificationLog" (
    "_id" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID,
    "channel" TEXT NOT NULL,
    "templateKey" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNotificationLog_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "_id" UUID NOT NULL,
    "type" "DisputeType" NOT NULL,
    "reporterId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "status" "AdminDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "adminNotes" TEXT,
    "assignedToId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "AdminPermissionGrant_userId_idx" ON "AdminPermissionGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminPermissionGrant_userId_permissionCode_key" ON "AdminPermissionGrant"("userId", "permissionCode");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorUserId_idx" ON "AdminAuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "BreakGlassCode_validFrom_validUntil_idx" ON "BreakGlassCode"("validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "AdminSlaConfig_area_isActive_idx" ON "AdminSlaConfig"("area", "isActive");

-- CreateIndex
CREATE INDEX "AdminNotificationLog_adminUserId_createdAt_idx" ON "AdminNotificationLog"("adminUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_isEnabled_idx" ON "FeatureFlag"("key", "isEnabled");

-- CreateIndex
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Dispute_reporterId_createdAt_idx" ON "Dispute"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "Dispute_type_status_idx" ON "Dispute"("type", "status");

-- CreateIndex
CREATE INDEX "Dispute_assignedToId_status_idx" ON "Dispute"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSlaConfig" ADD CONSTRAINT "AdminSlaConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNotificationLog" ADD CONSTRAINT "AdminNotificationLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
