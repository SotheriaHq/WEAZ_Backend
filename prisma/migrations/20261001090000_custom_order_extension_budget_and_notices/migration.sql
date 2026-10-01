-- Time extensions, told as a record instead of as an overwrite.
--
-- Granting an extension used to move `promisedProductionAt` / `promisedDispatchAt`
-- / `promisedDeliveryAt` in place, which answered "when is it due" and destroyed
-- "what was promised". After one accepted extension nobody could say whether the
-- brand was late, which is exactly the question a refund argument turns on. The
-- `original*` columns keep the commitment the shopper paid against; they stay
-- NULL until the first extension, because until then `promised*` IS the original.
--
-- The budget is counted in DAYS GRANTED, not in requests: two requests of three
-- days is still six days the shopper never signed up for. `approvedExtensionCount`
-- caps the number of times they are asked, `totalExtensionDaysGranted` caps what
-- they can lose. Only APPROVED requests consume either — a request the shopper
-- ignored or refused must not burn the brand's allowance.
--
-- `respondByAt` gives a request a deadline and `expiredAt` records that it ran
-- out. Silence is NOT consent: the sweep marks the request EXPIRED and escalates
-- to an admin. `voidedAt` + the VOIDED status close the other hole, where the
-- stage a request was buying time for is reached while the request is still
-- asking the shopper to grant it.
--
-- `buyerAdminNoticeAt` / `buyerAdminNoticeAckAt` give the shopper the one-way
-- admin notice channel the brand has had all along (`brandAdminNotice*`): admin
-- writes, the other side reads and acknowledges, neither replies.
--
-- `adminIntervention*` is deliberately separate from `status = DISPUTED`. A
-- dispute is a fact about the order; an intervention is a job somebody owns. A
-- rejected extension raises both, so it cannot sit in the gap between them.

ALTER TABLE "CustomOrder"
  ADD COLUMN "originalPromisedProductionAt" TIMESTAMP(3),
  ADD COLUMN "originalPromisedDispatchAt" TIMESTAMP(3),
  ADD COLUMN "originalPromisedDeliveryAt" TIMESTAMP(3),
  ADD COLUMN "totalExtensionDaysGranted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvedExtensionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "buyerAdminNoticeAt" TIMESTAMP(3),
  ADD COLUMN "buyerAdminNoticeAckAt" TIMESTAMP(3),
  ADD COLUMN "adminInterventionAt" TIMESTAMP(3),
  ADD COLUMN "adminInterventionReason" TEXT,
  ADD COLUMN "adminInterventionResolvedAt" TIMESTAMP(3),
  ADD COLUMN "adminInterventionResolvedById" UUID;

-- VOIDED: the stage this request was buying time for was already reached.
ALTER TYPE "CustomOrderExtensionResponseStatus" ADD VALUE IF NOT EXISTS 'VOIDED';

-- The timeline is the audit trail for all of this, so each new beat gets its own
-- event type rather than being folded into EXTENSION_RESOLVED. The deadline
-- warning in particular is read back by the cron to avoid nudging twice.
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'EXTENSION_DEADLINE_WARNED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'EXTENSION_EXPIRED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'EXTENSION_VOIDED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'ADMIN_INTERVENTION_OPENED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'ADMIN_INTERVENTION_RESOLVED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'ADMIN_NOTICE_SENT';

ALTER TABLE "CustomOrderExtensionRequest"
  ADD COLUMN "buyerNote" TEXT,
  ADD COLUMN "brandNote" TEXT,
  ADD COLUMN "respondByAt" TIMESTAMP(3),
  ADD COLUMN "appliedExtraDays" INTEGER,
  ADD COLUMN "expiredAt" TIMESTAMP(3),
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;

-- Backfill the budget from the rows that already exist, so an order that was
-- granted an extension before this migration does not get a fresh allowance.
-- Pre-migration requests never recorded what was applied, so the request amount
-- is the best available answer and is also what was actually added to the dates.
UPDATE "CustomOrderExtensionRequest"
   SET "appliedExtraDays" = "requestedExtraDays"
 WHERE "buyerResponseStatus" = 'ACCEPTED'
   AND "appliedExtraDays" IS NULL;

UPDATE "CustomOrder" AS o
   SET "approvedExtensionCount" = granted."count",
       "totalExtensionDaysGranted" = granted."days"
  FROM (
         SELECT "customOrderId",
                COUNT(*)::int AS "count",
                COALESCE(SUM(COALESCE("appliedExtraDays", "requestedExtraDays")), 0)::int AS "days"
           FROM "CustomOrderExtensionRequest"
          WHERE "buyerResponseStatus" = 'ACCEPTED'
          GROUP BY "customOrderId"
       ) AS granted
 WHERE o."id" = granted."customOrderId";

-- The expiry sweep reads open requests by deadline across every order; the
-- deadline sweep reads live orders by production promise.
CREATE INDEX "CustomOrderExtensionRequest_buyerResponseStatus_respondByAt_idx"
  ON "CustomOrderExtensionRequest" ("buyerResponseStatus", "respondByAt");
CREATE INDEX "CustomOrder_adminInterventionAt_idx"
  ON "CustomOrder" ("adminInterventionAt");
CREATE INDEX "CustomOrder_status_promisedProductionAt_idx"
  ON "CustomOrder" ("status", "promisedProductionAt");
