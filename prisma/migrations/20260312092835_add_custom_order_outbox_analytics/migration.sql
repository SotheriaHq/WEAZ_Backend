-- CreateEnum
CREATE TYPE "CustomOrderOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "CustomOrderNotificationOutbox" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "actorId" UUID,
    "notificationType" "NotificationType" NOT NULL,
    "payloadJson" JSONB,
    "targetJson" JSONB,
    "dedupeMs" INTEGER,
    "status" "CustomOrderOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderAnalyticsEvent" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "timelineEventId" UUID,
    "actorType" "CustomOrderActorType",
    "actorId" UUID,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomOrderAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomOrderNotificationOutbox_status_availableAt_createdAt_idx" ON "CustomOrderNotificationOutbox"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderNotificationOutbox_customOrderId_createdAt_idx" ON "CustomOrderNotificationOutbox"("customOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderNotificationOutbox_recipientId_createdAt_idx" ON "CustomOrderNotificationOutbox"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderAnalyticsEvent_timelineEventId_key" ON "CustomOrderAnalyticsEvent"("timelineEventId");

-- CreateIndex
CREATE INDEX "CustomOrderAnalyticsEvent_customOrderId_occurredAt_idx" ON "CustomOrderAnalyticsEvent"("customOrderId", "occurredAt");

-- CreateIndex
CREATE INDEX "CustomOrderAnalyticsEvent_eventType_occurredAt_idx" ON "CustomOrderAnalyticsEvent"("eventType", "occurredAt");

-- AddForeignKey
ALTER TABLE "CustomOrderNotificationOutbox" ADD CONSTRAINT "CustomOrderNotificationOutbox_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderAnalyticsEvent" ADD CONSTRAINT "CustomOrderAnalyticsEvent_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderAnalyticsEvent" ADD CONSTRAINT "CustomOrderAnalyticsEvent_timelineEventId_fkey" FOREIGN KEY ("timelineEventId") REFERENCES "CustomOrderTimelineEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
