CREATE TYPE "StorePaymentAccountStatus" AS ENUM (
  'PENDING_SETUP',
  'PENDING_SYNC',
  'ACTIVE',
  'SYNC_ERROR'
);

CREATE TABLE "StorePaymentAccount" (
  "_id" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "status" "StorePaymentAccountStatus" NOT NULL DEFAULT 'PENDING_SETUP',
  "provider" TEXT NOT NULL DEFAULT 'PAYSTACK',
  "countryCode" TEXT NOT NULL DEFAULT 'NG',
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "businessName" TEXT,
  "primaryContactName" TEXT,
  "primaryContactEmail" TEXT,
  "primaryContactPhone" TEXT,
  "bankCode" TEXT,
  "bankName" TEXT,
  "accountName" TEXT,
  "accountNumberEncrypted" TEXT,
  "accountNumberLast4" TEXT,
  "isAccountResolved" BOOLEAN NOT NULL DEFAULT false,
  "accountResolvedAt" TIMESTAMP(3),
  "subaccountCode" TEXT,
  "subaccountId" TEXT,
  "subaccountActive" BOOLEAN NOT NULL DEFAULT false,
  "subaccountVerified" BOOLEAN NOT NULL DEFAULT false,
  "subaccountLastSyncAt" TIMESTAMP(3),
  "transferRecipientCode" TEXT,
  "transferRecipientId" TEXT,
  "transferRecipientActive" BOOLEAN NOT NULL DEFAULT false,
  "transferRecipientLastSyncAt" TIMESTAMP(3),
  "lastSyncError" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StorePaymentAccount_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "StorePaymentAccount_brandId_key" ON "StorePaymentAccount"("brandId");
CREATE UNIQUE INDEX "StorePaymentAccount_subaccountCode_key" ON "StorePaymentAccount"("subaccountCode");
CREATE UNIQUE INDEX "StorePaymentAccount_transferRecipientCode_key" ON "StorePaymentAccount"("transferRecipientCode");
CREATE INDEX "StorePaymentAccount_status_updatedAt_idx" ON "StorePaymentAccount"("status", "updatedAt");

ALTER TABLE "StorePaymentAccount"
ADD CONSTRAINT "StorePaymentAccount_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
