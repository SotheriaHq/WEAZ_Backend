-- Brand-facing "admin notices" state: bumped when an admin sends the brand a
-- reminder or a dispute notice; the brand acknowledges to clear the queue flag.
-- Read-only for the brand (brands never reply to admin).
ALTER TABLE "CustomOrder"
  ADD COLUMN "brandAdminNoticeAt" TIMESTAMP(3),
  ADD COLUMN "brandAdminNoticeAckAt" TIMESTAMP(3);
