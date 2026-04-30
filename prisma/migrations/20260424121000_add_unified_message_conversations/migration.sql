DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessageConversationType') THEN
    CREATE TYPE "MessageConversationType" AS ENUM ('BUYER_BRAND', 'BRAND_BRAND');
  END IF;
END $$;

ALTER TABLE "MessageThread"
  ADD COLUMN IF NOT EXISTS "conversationType" "MessageConversationType",
  ADD COLUMN IF NOT EXISTS "buyerUserId" UUID,
  ADD COLUMN IF NOT EXISTS "brandOwnerUserId" UUID,
  ADD COLUMN IF NOT EXISTS "brandAId" UUID,
  ADD COLUMN IF NOT EXISTS "brandBId" UUID,
  ADD COLUMN IF NOT EXISTS "pairKey" TEXT;

ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "contextType" "MessageContextType" NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN IF NOT EXISTS "orderId" UUID,
  ADD COLUMN IF NOT EXISTS "customOrderId" UUID;

CREATE TABLE IF NOT EXISTS "MessageThreadOrderLink" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "threadId" UUID NOT NULL,
  "orderId" UUID,
  "customOrderId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageThreadOrderLink_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MessageThreadOrderLink_threadId_fkey'
  ) THEN
    ALTER TABLE "MessageThreadOrderLink"
      ADD CONSTRAINT "MessageThreadOrderLink_threadId_fkey"
      FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MessageThreadOrderLink_orderId_fkey'
  ) THEN
    ALTER TABLE "MessageThreadOrderLink"
      ADD CONSTRAINT "MessageThreadOrderLink_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MessageThreadOrderLink_customOrderId_fkey'
  ) THEN
    ALTER TABLE "MessageThreadOrderLink"
      ADD CONSTRAINT "MessageThreadOrderLink_customOrderId_fkey"
      FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "MessageThreadOrderLink" ("threadId", "orderId")
SELECT mt."id", mt."orderId"
FROM "MessageThread" mt
WHERE mt."orderId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "MessageThreadOrderLink" ("threadId", "customOrderId")
SELECT mt."id", mt."customOrderId"
FROM "MessageThread" mt
WHERE mt."customOrderId" IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE "Message" m
SET
  "contextType" = mt."contextType",
  "orderId" = mt."orderId",
  "customOrderId" = mt."customOrderId"
FROM "MessageThread" mt
WHERE m."threadId" = mt."id"
  AND (m."orderId" IS NULL AND m."customOrderId" IS NULL);

UPDATE "MessageThread" mt
SET
  "conversationType" = 'BUYER_BRAND',
  "buyerUserId" = COALESCE(mt."buyerId", co."buyerId"),
  "brandId" = COALESCE(mt."brandId", co."brandId"),
  "brandOwnerUserId" = b."ownerId"
FROM "CustomOrder" co
JOIN "Brand" b ON b."_id" = co."brandId"
WHERE co."id" = mt."customOrderId"
  AND COALESCE(mt."buyerId", co."buyerId") IS NOT NULL
  AND mt."conversationType" IS NULL;

UPDATE "MessageThread" mt
SET
  "conversationType" = 'BUYER_BRAND',
  "buyerUserId" = COALESCE(mt."buyerId", o."buyerId"),
  "brandId" = COALESCE(mt."brandId", o."brandId"),
  "brandOwnerUserId" = b."ownerId"
FROM "Order" o
JOIN "Brand" b ON b."_id" = o."brandId"
WHERE o."_id" = mt."orderId"
  AND COALESCE(mt."buyerId", o."buyerId") IS NOT NULL
  AND mt."conversationType" IS NULL;

UPDATE "MessageThread" mt
SET
  "conversationType" = 'BUYER_BRAND',
  "buyerUserId" = mt."buyerId",
  "brandOwnerUserId" = b."ownerId"
FROM "Brand" b
WHERE b."_id" = mt."brandId"
  AND mt."buyerId" IS NOT NULL
  AND mt."conversationType" IS NULL;

CREATE INDEX IF NOT EXISTS "MessageThread_conversationType_lastMessageAt_idx"
  ON "MessageThread"("conversationType", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "MessageThread_pairKey_idx"
  ON "MessageThread"("pairKey");

CREATE UNIQUE INDEX IF NOT EXISTS "MessageThread_pairKey_unique_idx"
  ON "MessageThread"("pairKey")
  WHERE "pairKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "MessageThreadOrderLink_orderId_key"
  ON "MessageThreadOrderLink"("orderId")
  WHERE "orderId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "MessageThreadOrderLink_customOrderId_key"
  ON "MessageThreadOrderLink"("customOrderId")
  WHERE "customOrderId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "MessageThreadOrderLink_threadId_createdAt_idx"
  ON "MessageThreadOrderLink"("threadId", "createdAt");

CREATE INDEX IF NOT EXISTS "Message_contextType_orderId_idx"
  ON "Message"("contextType", "orderId");

CREATE INDEX IF NOT EXISTS "Message_contextType_customOrderId_idx"
  ON "Message"("contextType", "customOrderId");
