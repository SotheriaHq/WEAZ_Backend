-- Drain all previous API/refund workers before this migration and restart all
-- workers on the owner-fenced release. Never invent an owner for an uncertain POST.
BEGIN;
LOCK TABLE "CustomOrderQueueRefund" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "CustomOrderQueueRefund"
    WHERE status = 'SUBMITTING' OR "lockedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Drain refund workers and reconcile in-flight custom refunds before owner-fencing migration';
  END IF;
END $$;

ALTER TABLE "CustomOrderQueueRefund" ADD COLUMN "leaseToken" uuid;
ALTER TABLE "CustomOrderQueueRefund" ADD CONSTRAINT "CustomOrderQueueRefund_owner_pair"
  CHECK (("lockedAt" IS NULL) = ("leaseToken" IS NULL));
ALTER TABLE "CustomOrderQueueRefund" ADD CONSTRAINT "CustomOrderQueueRefund_submitting_owner"
  CHECK (status <> 'SUBMITTING' OR "leaseToken" IS NOT NULL);
CREATE INDEX "CustomOrderQueueRefund_status_lockedAt_idx"
  ON "CustomOrderQueueRefund" (status, "lockedAt", id);
COMMIT;
