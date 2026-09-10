-- Structured location on the shopper profile.
--
-- `UserProfile.address` was the only location field, and it held whatever the
-- user typed into one box. That cannot be read back into a country/state/city
-- picker, so every visit to the edit form started from nothing.
--
-- Nullable with no backfill on purpose: the existing free-text value stays in
-- `address` and is still what `location` falls back to, so nothing that renders
-- a profile today changes until a user actually picks a country. Splitting the
-- stored strings by comma would guess, and a guess written into a column is
-- indistinguishable from a fact afterwards.
ALTER TABLE "UserProfile" ADD COLUMN "country" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "state" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "city" TEXT;
