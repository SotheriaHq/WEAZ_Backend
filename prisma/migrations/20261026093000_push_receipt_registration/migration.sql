ALTER TABLE "PushDeviceToken" ADD COLUMN "registrationVersion" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "PushDeliveryReceipt" ADD COLUMN "tokenRegistrationVersion" UUID;

-- Historical receipts have no proven registration version. Their delivery
-- outcomes remain available, but no registration version is inferred.
