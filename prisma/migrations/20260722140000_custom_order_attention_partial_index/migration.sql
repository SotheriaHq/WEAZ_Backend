-- Partial composite index for the admin attention queue:
-- - only indexes rows that currently need attention (sparse)
-- - supports ORDER BY adminAttentionRequiredAt DESC, createdAt DESC
-- - dashboard count + attention=1 list filter hit this instead of a full-table sort
CREATE INDEX IF NOT EXISTS "CustomOrder_attention_active_created_idx"
  ON "CustomOrder" ("adminAttentionRequiredAt" DESC, "createdAt" DESC)
  WHERE "adminAttentionRequiredAt" IS NOT NULL
    AND "anonymizedAt" IS NULL;
