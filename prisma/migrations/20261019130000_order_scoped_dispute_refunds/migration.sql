BEGIN;

-- Preserve cancellation history while permitting independent, replay-safe dispute refunds.
ALTER TABLE "CustomOrderQueueRefund" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "CustomOrderQueueRefund" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CANCELLATION';
UPDATE "CustomOrderQueueRefund" SET "requestKey" = 'custom-order:' || "customOrderId"::text || ':cancellation';
ALTER TABLE "CustomOrderQueueRefund" ALTER COLUMN "requestKey" SET NOT NULL;
DROP INDEX "CustomOrderQueueRefund_customOrderId_key";
CREATE UNIQUE INDEX "CustomOrderQueueRefund_requestKey_key" ON "CustomOrderQueueRefund"("requestKey");
CREATE INDEX "CustomOrderQueueRefund_customOrderId_createdAt_idx" ON "CustomOrderQueueRefund"("customOrderId", "createdAt");
ALTER TABLE "CustomOrderQueueRefund" ADD CONSTRAINT "CustomOrderQueueRefund_kind_check" CHECK ("kind" IN ('CANCELLATION', 'PARTIAL'));

COMMIT;
