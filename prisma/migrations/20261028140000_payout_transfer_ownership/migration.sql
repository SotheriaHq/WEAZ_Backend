BEGIN;
LOCK TABLE "Payout" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "Payout"
  ADD COLUMN "transferLeaseToken" UUID,
  ADD COLUMN "transferLockedAt" TIMESTAMP(3),
  ADD CONSTRAINT "Payout_transfer_owner_pair_check" CHECK (
    ("transferLeaseToken" IS NULL) = ("transferLockedAt" IS NULL)
  );
COMMIT;
