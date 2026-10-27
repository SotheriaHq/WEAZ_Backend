-- Bound direct-alias lookup and FK SET NULL repair when canonical tags change.
CREATE INDEX "Tag_aliasOfTagId_idx" ON "Tag"("aliasOfTagId");
