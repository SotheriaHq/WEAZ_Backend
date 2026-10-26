-- A requested provider refund freezes release of the hold until it settles.
-- Added on its own: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "EscrowHoldStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
