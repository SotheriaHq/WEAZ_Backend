CREATE TABLE "RunwayAffinityCache" (
  "userId" UUID PRIMARY KEY REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  "payload" JSONB NOT NULL,
  "builtAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RunwayAffinityCache_expiresAt_idx" ON "RunwayAffinityCache" ("expiresAt");
ALTER TABLE "RunwayAffinityCache" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "Collection_runway_fresh_idx" ON "Collection" ("createdAt" DESC, "_id") WHERE domain = 'DESIGN' AND status = 'PUBLISHED' AND visibility = 'PUBLIC' AND "deletedAt" IS NULL;
CREATE INDEX "Collection_runway_quality_idx" ON "Collection" ("likesCount" DESC, "_id") WHERE domain = 'DESIGN' AND status = 'PUBLISHED' AND visibility = 'PUBLIC' AND "deletedAt" IS NULL;
CREATE INDEX "Collection_runway_tags_idx" ON "Collection" USING GIN (tags) WHERE domain = 'DESIGN' AND status = 'PUBLISHED' AND visibility = 'PUBLIC' AND "deletedAt" IS NULL;

CREATE INDEX "EntityFilter_runway_feature_time_idx" ON "EntityFilter" ("filterValueId", "createdAt" DESC, "entityId") WHERE "entityType" IN ('DESIGN', 'COLLECTION');
