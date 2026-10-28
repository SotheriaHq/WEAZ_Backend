-- Current-state semantic dedupe reads at most 25 candidates per recipient/type.
CREATE INDEX "Notification_recipientId_type_createdAt_idx"
  ON "Notification"("recipientId", type, "createdAt");
