-- Phone-number changes are confirmed with a 6-digit code emailed to the
-- account's verified address, reusing the existing EmailLoginCode machinery.
ALTER TYPE "LoginCodePurpose" ADD VALUE IF NOT EXISTS 'PHONE_CHANGE';

-- The value a code authorises (the new phone number). Held on the code row so
-- an unconfirmed number never sits on the user record.
ALTER TABLE "EmailLoginCode" ADD COLUMN IF NOT EXISTS "pendingValue" TEXT;
