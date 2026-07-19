-- Additive: per-user public-display privacy toggles. Defaults keep current
-- behavior (username and location visible) for every existing account.
ALTER TABLE "UserProfile" ADD COLUMN "showUsername" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserProfile" ADD COLUMN "showLocation" BOOLEAN NOT NULL DEFAULT true;
