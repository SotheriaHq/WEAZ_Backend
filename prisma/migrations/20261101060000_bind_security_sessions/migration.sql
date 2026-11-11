-- Existing credentials deliberately require a fresh sign-in at this cutover.
-- No users, orders, content or payment data is removed.
ALTER TABLE "RefreshToken" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "deviceKey" TEXT, ADD COLUMN "deviceName" TEXT, ADD COLUMN "parentSessionId" UUID;
-- Old binaries must keep producing version 0 throughout a rolling deploy.
-- The new issuer explicitly writes version 1 after fresh authentication.
ALTER TABLE "StudioHandoffCode" ADD COLUMN "sourceAuthVersion" INTEGER, ADD COLUMN "sourceSessionId" UUID;
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_parentSessionId_fkey"
 FOREIGN KEY ("parentSessionId") REFERENCES "RefreshToken"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioHandoffCode" ADD CONSTRAINT "StudioHandoffCode_sourceSessionId_fkey"
 FOREIGN KEY ("sourceSessionId") REFERENCES "RefreshToken"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "RefreshToken_userId_deviceKey_createdAt_idx" ON "RefreshToken"("userId", "deviceKey", "createdAt");
CREATE INDEX "RefreshToken_parentSessionId_idx" ON "RefreshToken"("parentSessionId");
CREATE INDEX "StudioHandoffCode_sourceSessionId_idx" ON "StudioHandoffCode"("sourceSessionId");

CREATE TABLE "SecuritySessionHistory" (
 "id" UUID PRIMARY KEY, "userId" UUID NOT NULL, "deviceKey" TEXT, "deviceName" TEXT,
 "userAgent" TEXT, "ipAddressMasked" TEXT, "parentSessionId" UUID,
 "createdAt" TIMESTAMP(3) NOT NULL, "lastUsedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
 "endedAt" TIMESTAMP(3), "endedReason" TEXT,
 CONSTRAINT "SecuritySessionHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SecuritySessionHistory_userId_deviceKey_createdAt_idx" ON "SecuritySessionHistory"("userId", "deviceKey", "createdAt");
CREATE INDEX "SecuritySessionHistory_endedAt_idx" ON "SecuritySessionHistory"("endedAt");
CREATE INDEX "SecuritySessionHistory_expiresAt_idx" ON "SecuritySessionHistory"("expiresAt");
-- Preserve pre-cutover sign-in records without inventing device identities.
INSERT INTO "SecuritySessionHistory" ("id", "userId", "userAgent", "createdAt", "lastUsedAt", "expiresAt", "endedAt", "endedReason")
 SELECT "_id", "userId", LEFT("userAgent",512), "createdAt", COALESCE("lastUsedAt","createdAt"), "expiresAt",
   LEAST(NOW(), "expiresAt"), CASE WHEN "expiresAt" <= NOW() THEN 'EXPIRED' ELSE 'SECURITY_UPGRADE' END
 FROM "RefreshToken" WHERE "expiresAt" > NOW() - INTERVAL '30 days';

-- A database trigger covers every credential-removal path, including FK cascades.
-- Only non-secret metadata is copied. Credentials remain solely in RefreshToken.
CREATE FUNCTION "record_security_session_history"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
   UPDATE "SecuritySessionHistory" SET "endedAt" = COALESCE("endedAt", LEAST(NOW(), OLD."expiresAt")),
     "endedReason" = COALESCE("endedReason", CASE WHEN OLD."expiresAt" <= NOW() THEN 'EXPIRED' ELSE 'SIGNED_OUT' END)
   WHERE "id" = OLD."_id";
   RETURN OLD;
 END IF;
 INSERT INTO "SecuritySessionHistory" ("id", "userId", "deviceKey", "deviceName", "userAgent", "ipAddressMasked",
   "parentSessionId", "createdAt", "lastUsedAt", "expiresAt", "endedAt", "endedReason")
 VALUES (NEW."_id", NEW."userId", NEW."deviceKey", LEFT(NEW."deviceName",80), LEFT(NEW."userAgent",512),
   CASE WHEN POSITION(':' IN COALESCE(NEW."ipAddress",'')) > 0 THEN SPLIT_PART(NEW."ipAddress",':',1) || ':' || SPLIT_PART(NEW."ipAddress",':',2) || ':xxxx:xxxx'
        WHEN NEW."ipAddress" ~ '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN SPLIT_PART(NEW."ipAddress",'.',1) || '.' || SPLIT_PART(NEW."ipAddress",'.',2) || '.xxx.xxx'
        ELSE NULL END,
   NEW."parentSessionId", NEW."createdAt", COALESCE(NEW."lastUsedAt", NEW."createdAt"), NEW."expiresAt",
   CASE WHEN NEW."sessionVersion" <> 1 THEN NOW() ELSE NULL END,
   CASE WHEN NEW."sessionVersion" <> 1 THEN 'SECURITY_UPGRADE' ELSE NULL END)
 ON CONFLICT ("id") DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt", "expiresAt" = EXCLUDED."expiresAt";
 RETURN NEW;
END $$;
CREATE TRIGGER "RefreshToken_record_security_history" AFTER INSERT OR UPDATE OR DELETE ON "RefreshToken"
 FOR EACH ROW EXECUTE FUNCTION "record_security_session_history"();
