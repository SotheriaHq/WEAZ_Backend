ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "pendingEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingEmailTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingEmailExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_pendingEmail_key"
  ON "User"("pendingEmail")
  WHERE "pendingEmail" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "User_pendingEmailTokenHash_key"
  ON "User"("pendingEmailTokenHash")
  WHERE "pendingEmailTokenHash" IS NOT NULL;
