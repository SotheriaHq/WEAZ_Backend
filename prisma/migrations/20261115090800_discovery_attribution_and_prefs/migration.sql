BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN     "marketPersonalization" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "marketRegionalOptIn" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "sourceSection" VARCHAR(80);

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "sourcePosition" INTEGER,
ADD COLUMN     "sourceSection" VARCHAR(80);

ALTER TABLE "CartItem" ADD CONSTRAINT cart_discovery_attribution_shape_check CHECK (
  ("sourceSection" IS NULL OR "sourceSection" ~ '^[a-z0-9][a-z0-9-]{0,79}$')
  AND ("sourcePosition" IS NULL OR ("sourceSection" IS NOT NULL AND "sourcePosition">=0))) NOT VALID;
ALTER TABLE "OrderItem" ADD CONSTRAINT order_discovery_attribution_shape_check CHECK (
  "sourceSection" IS NULL OR "sourceSection" ~ '^[a-z0-9][a-z0-9-]{0,79}$') NOT VALID;
-- Preferences are not consent and cannot activate gated profiling or region ranking.
COMMIT;
