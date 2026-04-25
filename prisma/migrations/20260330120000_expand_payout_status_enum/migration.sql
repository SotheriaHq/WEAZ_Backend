-- Expand PayoutStatus safely for PostgreSQL shadow-db validation.
-- PostgreSQL does not allow a freshly-added enum value to be used in the
-- same transaction, so recreate the enum and cast existing rows instead.

-- Old enum: PENDING, PROCESSING, PAID, FAILED
-- New enum: PENDING_APPROVAL, APPROVED, PROCESSING, PAID, FAILED, REJECTED, ON_HOLD, RECONCILIATION_REVIEW

ALTER TABLE "Payout" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "PayoutStatus" RENAME TO "PayoutStatus_old";

CREATE TYPE "PayoutStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'PAID',
  'FAILED',
  'REJECTED',
  'ON_HOLD',
  'RECONCILIATION_REVIEW'
);

ALTER TABLE "Payout"
  ALTER COLUMN "status" TYPE "PayoutStatus"
  USING (
    CASE
      WHEN "status"::text = 'PENDING' THEN 'PENDING_APPROVAL'
      ELSE "status"::text
    END
  )::"PayoutStatus";

ALTER TABLE "Payout" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';

DROP TYPE "PayoutStatus_old";
