BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
-- Existing sessions intentionally remain unbound and require a fresh sign-in.
-- Never infer the authority of an earlier sign-in from the user's current role.
ALTER TABLE "RefreshToken"
  ADD COLUMN "issuedAuthVersion" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_issuedAuthVersion_check" CHECK ("issuedAuthVersion" >= -1);
COMMIT;
