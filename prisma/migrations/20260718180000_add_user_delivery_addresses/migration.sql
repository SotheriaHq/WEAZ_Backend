-- Additive: server-side delivery address book so web and mobile checkout share
-- the same saved addresses (previously browser-localStorage only).
ALTER TABLE "UserProfile" ADD COLUMN "deliveryAddresses" JSONB;
