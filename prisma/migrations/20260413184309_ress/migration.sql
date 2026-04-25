-- CreateEnum
CREATE TYPE "CardValidationSessionStatus" AS ENUM ('VALIDATED', 'USED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "cardValidationSessionId" UUID,
ADD COLUMN     "savedPaymentMethodId" UUID;

-- CreateTable
CREATE TABLE "SavedPaymentMethod" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "brand" TEXT,
    "bank" TEXT,
    "last4" TEXT NOT NULL,
    "expMonth" TEXT,
    "expYear" TEXT,
    "holderName" TEXT,
    "providerAuthorizationCodeEncrypted" TEXT,
    "providerAuthorizationSignature" TEXT,
    "providerAuthorizationMeta" JSONB,
    "sourcePaymentAttemptId" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardValidationSession" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "gateway" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "CardValidationSessionStatus" NOT NULL DEFAULT 'VALIDATED',
    "email" TEXT NOT NULL,
    "useSavedCard" BOOLEAN NOT NULL DEFAULT false,
    "savedPaymentMethodId" UUID,
    "savedCardLegacyId" TEXT,
    "paymentDataFingerprint" TEXT NOT NULL,
    "cardSummary" JSONB,
    "validatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardValidationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_buyerId_status_updatedAt_idx" ON "SavedPaymentMethod"("buyerId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_buyerId_isDefault_idx" ON "SavedPaymentMethod"("buyerId", "isDefault");

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_provider_paymentMethod_status_idx" ON "SavedPaymentMethod"("provider", "paymentMethod", "status");

-- CreateIndex
CREATE INDEX "SavedPaymentMethod_sourcePaymentAttemptId_idx" ON "SavedPaymentMethod"("sourcePaymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedPaymentMethod_buyerId_providerAuthorizationSignature_key" ON "SavedPaymentMethod"("buyerId", "providerAuthorizationSignature");

-- CreateIndex
CREATE INDEX "CardValidationSession_buyerId_status_expiresAt_idx" ON "CardValidationSession"("buyerId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CardValidationSession_savedPaymentMethodId_status_idx" ON "CardValidationSession"("savedPaymentMethodId", "status");

-- CreateIndex
CREATE INDEX "CardValidationSession_expiresAt_idx" ON "CardValidationSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CardValidationSession_paymentDataFingerprint_idx" ON "CardValidationSession"("paymentDataFingerprint");

-- CreateIndex
CREATE INDEX "PaymentAttempt_savedPaymentMethodId_idx" ON "PaymentAttempt"("savedPaymentMethodId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_cardValidationSessionId_idx" ON "PaymentAttempt"("cardValidationSessionId");

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_savedPaymentMethodId_fkey" FOREIGN KEY ("savedPaymentMethodId") REFERENCES "SavedPaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_cardValidationSessionId_fkey" FOREIGN KEY ("cardValidationSessionId") REFERENCES "CardValidationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedPaymentMethod" ADD CONSTRAINT "SavedPaymentMethod_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedPaymentMethod" ADD CONSTRAINT "SavedPaymentMethod_sourcePaymentAttemptId_fkey" FOREIGN KEY ("sourcePaymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardValidationSession" ADD CONSTRAINT "CardValidationSession_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardValidationSession" ADD CONSTRAINT "CardValidationSession_savedPaymentMethodId_fkey" FOREIGN KEY ("savedPaymentMethodId") REFERENCES "SavedPaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
