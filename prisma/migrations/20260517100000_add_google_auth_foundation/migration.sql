CREATE TYPE "AuthProvider" AS ENUM (
  'GOOGLE'
);

CREATE TYPE "PasswordCredentialStatus" AS ENUM (
  'ENABLED',
  'NOT_SET',
  'DISABLED'
);

CREATE TYPE "LoginCodePurpose" AS ENUM (
  'PASSWORD_SETUP'
);

ALTER TABLE "User"
ADD COLUMN "passwordCredentialStatus" "PasswordCredentialStatus" NOT NULL DEFAULT 'ENABLED';

ALTER TABLE "User"
ALTER COLUMN "password" DROP NOT NULL;

CREATE TABLE "AuthIdentity" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "AuthProvider" NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "email" TEXT,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailLoginCode" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "purpose" "LoginCodePurpose" NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailLoginCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordSetupToken" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordSetupToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthIdentity_provider_providerSubject_key"
ON "AuthIdentity"("provider", "providerSubject");

CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");
CREATE INDEX "AuthIdentity_email_idx" ON "AuthIdentity"("email");

CREATE INDEX "EmailLoginCode_userId_purpose_expiresAt_idx"
ON "EmailLoginCode"("userId", "purpose", "expiresAt");

CREATE INDEX "EmailLoginCode_codeHash_idx" ON "EmailLoginCode"("codeHash");

CREATE UNIQUE INDEX "PasswordSetupToken_tokenHash_key"
ON "PasswordSetupToken"("tokenHash");

CREATE INDEX "PasswordSetupToken_userId_expiresAt_idx"
ON "PasswordSetupToken"("userId", "expiresAt");

ALTER TABLE "AuthIdentity"
ADD CONSTRAINT "AuthIdentity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailLoginCode"
ADD CONSTRAINT "EmailLoginCode_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordSetupToken"
ADD CONSTRAINT "PasswordSetupToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
