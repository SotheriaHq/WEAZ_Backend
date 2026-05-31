-- CreateTable
CREATE TABLE "OperationalAlert" (
    "_id" UUID NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "event" VARCHAR(160) NOT NULL,
    "title" VARCHAR(240),
    "message" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    "actorId" UUID,
    "userId" UUID,
    "entityType" VARCHAR(80),
    "entityId" VARCHAR(120),
    "correlationId" VARCHAR(120),
    "metadata" JSONB,
    "dedupeKey" VARCHAR(220),
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" UUID,
    "ignoredAt" TIMESTAMP(3),
    "ignoredBy" UUID,
    "notificationQueuedAt" TIMESTAMP(3),
    "emailQueuedAt" TIMESTAMP(3),

    CONSTRAINT "OperationalAlert_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalAlert_dedupeKey_key" ON "OperationalAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "OperationalAlert_status_severity_lastSeenAt_idx" ON "OperationalAlert"("status", "severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_category_status_lastSeenAt_idx" ON "OperationalAlert"("category", "status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_event_lastSeenAt_idx" ON "OperationalAlert"("event", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_correlationId_idx" ON "OperationalAlert"("correlationId");

-- CreateIndex
CREATE INDEX "OperationalAlert_entityType_entityId_idx" ON "OperationalAlert"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "OperationalAlert_actorId_lastSeenAt_idx" ON "OperationalAlert"("actorId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalAlert_userId_lastSeenAt_idx" ON "OperationalAlert"("userId", "lastSeenAt");
