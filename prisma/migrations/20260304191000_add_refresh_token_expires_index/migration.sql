-- Improves refresh-session pruning and refresh lookup performance by expiry date.
CREATE INDEX IF NOT EXISTS "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
