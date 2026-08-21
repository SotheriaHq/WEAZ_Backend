-- Brand-controlled visibility for the store contact email.
--
-- Additive and defaulted to FALSE so every existing brand keeps the behaviour
-- they have today (contact email not published) until they choose otherwise.
-- Publishing an address someone gave us for operational contact is a decision
-- only that brand can make, so the safe default is the closed one.
--
-- `IF NOT EXISTS` because this migration is additive and must be safe to
-- re-apply after a partially-failed deploy.
ALTER TABLE "Brand"
  ADD COLUMN IF NOT EXISTS "contactEmailPublic" BOOLEAN NOT NULL DEFAULT false;
