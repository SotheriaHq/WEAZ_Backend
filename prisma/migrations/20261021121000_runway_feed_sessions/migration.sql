CREATE TABLE "RunwayFeedSession" (
  "id" UUID PRIMARY KEY,
  "userId" UUID REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  "categoryKey" VARCHAR(80) NOT NULL,
  "designIds" UUID[] NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RunwayFeedSession_expiresAt_idx" ON "RunwayFeedSession" ("expiresAt");
CREATE INDEX "RunwayFeedSession_userId_idx" ON "RunwayFeedSession" ("userId");
ALTER TABLE "RunwayFeedSession" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "CollectionMediaReaction_user_time_idx" ON "CollectionMediaReaction" ("userId", "createdAt" DESC);
CREATE INDEX "CommentV2_user_time_idx" ON "CommentV2" ("userId", "createdAt" DESC) WHERE "deletedAt" IS NULL;
UPDATE "FeedCategory" SET "key" = 'african-casual', "label" = 'African Casual', "description" = 'Contemporary everyday African fashion with explicit casual classification.' WHERE "key" = 'african-style' AND NOT EXISTS (SELECT 1 FROM "FeedCategory" WHERE "key" = 'african-casual');
UPDATE "FeedCategory" SET "status" = 'ACTIVE', "rankingProfileKey" = 'runway-v2' WHERE "key" IN ('discover', 'explore', 'for-you', 'african-casual', 'casual-style');
