BEGIN;
DROP INDEX "SecurityFactor_one_live_totp_per_user";
CREATE UNIQUE INDEX "SecurityFactor_one_verified_totp_per_user" ON "SecurityFactor"("userId")
  WHERE kind = 'TOTP' AND "revokedAt" IS NULL AND "verifiedAt" IS NOT NULL;
CREATE UNIQUE INDEX "SecurityFactor_one_pending_totp_per_user" ON "SecurityFactor"("userId")
  WHERE kind = 'TOTP' AND "revokedAt" IS NULL AND "verifiedAt" IS NULL;
ALTER TABLE "SecurityFactor" ADD COLUMN "replacesFactorId" UUID;
CREATE UNIQUE INDEX "SecurityFactor_id_userId_key" ON "SecurityFactor"("id","userId");
CREATE INDEX "SecurityFactor_replacesFactorId_userId_idx" ON "SecurityFactor"("replacesFactorId","userId");
ALTER TABLE "SecurityFactor" ADD CONSTRAINT "SecurityFactor_replacement_owner_fkey"
  FOREIGN KEY ("replacesFactorId","userId") REFERENCES "SecurityFactor"("id","userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "SecurityFactor" ADD CONSTRAINT "SecurityFactor_replacement_not_self"
  CHECK ("replacesFactorId" IS NULL OR "replacesFactorId" <> id);
COMMIT;
