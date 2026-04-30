CREATE TABLE "StudioHandoffCode" (
    "_id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "intendedPath" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioHandoffCode_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "StudioHandoffCode_codeHash_key" ON "StudioHandoffCode"("codeHash");
CREATE INDEX "StudioHandoffCode_userId_createdAt_idx" ON "StudioHandoffCode"("userId", "createdAt");
CREATE INDEX "StudioHandoffCode_expiresAt_idx" ON "StudioHandoffCode"("expiresAt");
CREATE INDEX "StudioHandoffCode_usedAt_idx" ON "StudioHandoffCode"("usedAt");

ALTER TABLE "StudioHandoffCode" ADD CONSTRAINT "StudioHandoffCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
