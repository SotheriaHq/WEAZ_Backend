ALTER TABLE "StorePaymentAccount" ADD COLUMN "bankClaimFingerprint" TEXT;
CREATE UNIQUE INDEX "StorePaymentAccount_bankClaimFingerprint_key" ON "StorePaymentAccount"("bankClaimFingerprint");
CREATE INDEX "StorePaymentAccount_unclaimed_bank_idx" ON "StorePaymentAccount"("_id")
  WHERE "accountNumberEncrypted" IS NOT NULL AND "bankClaimFingerprint" IS NULL;

CREATE TABLE "StorePayoutBankClaim" (
  "fingerprint" TEXT PRIMARY KEY, "keyId" TEXT NOT NULL, "brandId" UUID NOT NULL,
  "recipientCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorePayoutBankClaim_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StorePayoutBankClaim_recipientCode_key" ON "StorePayoutBankClaim"("recipientCode");
CREATE INDEX "StorePayoutBankClaim_brandId_idx" ON "StorePayoutBankClaim"("brandId");
ALTER TABLE "StorePaymentAccount" ADD CONSTRAINT "StorePaymentAccount_bankClaimFingerprint_fkey"
  FOREIGN KEY ("bankClaimFingerprint") REFERENCES "StorePayoutBankClaim"("fingerprint") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE TABLE "StorePayoutIdentityState" (
  "id" TEXT PRIMARY KEY, "keyId" TEXT, "ready" BOOLEAN NOT NULL DEFAULT false, "updatedAt" TIMESTAMP(3) NOT NULL
);
INSERT INTO "StorePayoutIdentityState" ("id","updatedAt") VALUES ('payout-bank-v1',CURRENT_TIMESTAMP);

CREATE TABLE "StorePaymentAccountSync" (
  "id" UUID PRIMARY KEY, "brandId" UUID NOT NULL, "bankFingerprint" TEXT NOT NULL,
  "commandDigest" TEXT NOT NULL, "commandEncrypted" TEXT NOT NULL,
  "actorId" UUID NOT NULL, "operationDigest" TEXT, "stage" TEXT NOT NULL DEFAULT 'ADMITTED',
  "leaseToken" UUID, "leaseExpiresAt" TIMESTAMP(3), "subaccountEncrypted" TEXT, "recipientEncrypted" TEXT,
  "failureCode" TEXT, "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorePaymentAccountSync_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StorePaymentAccountSync_stage_check" CHECK ("stage" IN ('ADMITTED','SUBACCOUNT_CREATING','SUBACCOUNT_CREATE_UNKNOWN','SUBACCOUNT_UPDATING','SUBACCOUNT_READY','RECIPIENT_SYNCING','RECIPIENT_READY','APPLIED','FAILED'))
);
CREATE UNIQUE INDEX "StorePaymentAccountSync_one_active_brand" ON "StorePaymentAccountSync"("brandId") WHERE "finishedAt" IS NULL;
CREATE INDEX "StorePaymentAccountSync_brandId_createdAt_idx" ON "StorePaymentAccountSync"("brandId","createdAt");
CREATE INDEX "StorePaymentAccountSync_finishedAt_leaseExpiresAt_idx" ON "StorePaymentAccountSync"("finishedAt","leaseExpiresAt");

CREATE TABLE "StorePayoutRecipientRetirement" (
  "recipientCode" TEXT PRIMARY KEY, "brandId" UUID NOT NULL, "bankFingerprint" TEXT,
  "replacementCode" TEXT NOT NULL, "leaseToken" UUID, "leaseExpiresAt" TIMESTAMP(3), "retiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorePayoutRecipientRetirement_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "StorePayoutRecipientRetirement_retiredAt_leaseExpiresAt_idx" ON "StorePayoutRecipientRetirement"("retiredAt","leaseExpiresAt");
CREATE INDEX "StorePayoutRecipientRetirement_bankFingerprint_retiredAt_idx" ON "StorePayoutRecipientRetirement"("bankFingerprint","retiredAt");
CREATE INDEX "Payout_providerRecipientCode_status_idx" ON "Payout"("providerRecipientCode","status");
