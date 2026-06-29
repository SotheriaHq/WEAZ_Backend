-- Phase 2B: lock CustomOrderConfiguration delivery range to 1-7 days (was 2-14).
-- Decision: migrate (clamp) legacy records rather than display-only grandfather.
--   - Clamp deliveryMaxDays above 7 down to 7.
--   - Clamp deliveryMinDays above 7 down to 7.
--   - Floor any 0 values up to 1.
--   - Preserve the invariant deliveryMinDays <= deliveryMaxDays after clamping.

UPDATE "CustomOrderConfiguration"
SET "deliveryMaxDays" = LEAST(GREATEST("deliveryMaxDays", 1), 7),
    "deliveryMinDays" = LEAST(GREATEST("deliveryMinDays", 1), 7)
WHERE "deliveryMaxDays" > 7
   OR "deliveryMinDays" > 7
   OR "deliveryMaxDays" < 1
   OR "deliveryMinDays" < 1;

-- Re-establish min <= max after independent clamping.
UPDATE "CustomOrderConfiguration"
SET "deliveryMinDays" = "deliveryMaxDays"
WHERE "deliveryMinDays" > "deliveryMaxDays";

-- Snapshots stored on versions retain their historical JSON and are intentionally
-- left untouched; live configuration rows are the source of truth for new orders.
