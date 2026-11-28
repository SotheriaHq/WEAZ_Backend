-- Owner L5 (28 Nov 2026): Market personalisation needs a one-time 18+ confirmation.
-- Additive and nullable: existing profiles stay unconfirmed, so nobody is personalised until they confirm.
ALTER TABLE "UserProfile" ADD COLUMN "marketAdultConfirmedAt" TIMESTAMPTZ(3);
