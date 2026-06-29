CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE "LegalDocumentKey" AS ENUM (
    'TERMS_OF_SERVICE',
    'PRIVACY_POLICY',
    'COOKIE_POLICY',
    'COMMUNITY_GUIDELINES',
    'SELLER_TERMS',
    'STORE_GUIDELINES',
    'BUYER_POLICY',
    'PAYMENT_POLICY',
    'COPYRIGHT_POLICY',
    'ACCOUNT_DELETION_POLICY',
    'CONTENT_POLICY'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "LegalAcceptanceSource" AS ENUM (
    'SIGNUP',
    'GOOGLE_SIGNUP',
    'CHECKOUT',
    'STORE_PUBLISH',
    'CONTENT_PUBLISH',
    'SETTINGS',
    'MANUAL'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "LegalAcceptance" (
  "_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "documentKey" "LegalDocumentKey" NOT NULL,
  "version" TEXT NOT NULL,
  "source" "LegalAcceptanceSource" NOT NULL,
  "surface" TEXT NOT NULL,
  "accountType" "UserType",
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "locale" TEXT,
  "appVersion" TEXT,
  "metadata" JSONB,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("_id")
);

ALTER TABLE "LegalAcceptance"
ADD CONSTRAINT "LegalAcceptance_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "LegalAcceptance_userId_documentKey_version_source_key"
ON "LegalAcceptance"("userId", "documentKey", "version", "source");

CREATE INDEX "LegalAcceptance_userId_documentKey_acceptedAt_idx"
ON "LegalAcceptance"("userId", "documentKey", "acceptedAt");

CREATE INDEX "LegalAcceptance_documentKey_version_idx"
ON "LegalAcceptance"("documentKey", "version");
