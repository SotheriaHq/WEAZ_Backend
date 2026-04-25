"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CustomOrderSideEffectsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrderSideEffectsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../prisma/prisma.service");
const notifications_queue_service_1 = require("../queue/notifications.queue.service");
const NOTIFICATION_DISPATCH_CONCURRENCY = 10;
const MAX_NOTIFICATION_DISPATCH_ATTEMPTS = 8;
let CustomOrderSideEffectsService = CustomOrderSideEffectsService_1 = class CustomOrderSideEffectsService {
    constructor(prisma, notificationsQueue) {
        this.prisma = prisma;
        this.notificationsQueue = notificationsQueue;
        this.logger = new common_1.Logger(CustomOrderSideEffectsService_1.name);
    }
    async enqueueNotification(params, tx) {
        const recipientIds = Array.from(new Set(params.recipientIds.filter(Boolean)));
        if (recipientIds.length === 0) {
            return;
        }
        const client = tx ?? this.prisma;
        await client.customOrderNotificationOutbox.createMany({
            data: recipientIds.map((recipientId) => ({
                customOrderId: params.customOrderId,
                recipientId,
                actorId: params.actorId ?? null,
                notificationType: params.notificationType,
                payloadJson: (params.payload ?? null),
                targetJson: (params.target ?? null),
                dedupeMs: params.dedupeMs,
                availableAt: params.availableAt ?? new Date(),
            })),
        });
    }
    async recordAnalyticsEvent(params, tx) {
        const client = tx ?? this.prisma;
        await client.customOrderAnalyticsEvent.create({
            data: {
                customOrderId: params.customOrderId,
                eventType: params.eventType,
                actorType: params.actorType ?? null,
                actorId: params.actorId ?? null,
                payloadJson: (params.payload ?? null),
                occurredAt: params.occurredAt ?? new Date(),
            },
        });
    }
    async syncTimelineAnalytics(batchSize = 200) {
        const timelineEvents = await this.prisma.customOrderTimelineEvent.findMany({
            where: { analyticsEvent: null },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
            select: {
                id: true,
                customOrderId: true,
                actorType: true,
                actorId: true,
                eventType: true,
                payloadJson: true,
                createdAt: true,
            },
        });
        if (timelineEvents.length === 0) {
            return 0;
        }
        await this.prisma.customOrderAnalyticsEvent.createMany({
            data: timelineEvents.map((event) => ({
                customOrderId: event.customOrderId,
                timelineEventId: event.id,
                actorType: event.actorType,
                actorId: event.actorId,
                eventType: event.eventType,
                payloadJson: (event.payloadJson ?? null),
                occurredAt: event.createdAt,
            })),
            skipDuplicates: true,
        });
        return timelineEvents.length;
    }
    async dispatchPendingNotifications(batchSize = 100) {
        const events = await this.prisma.customOrderNotificationOutbox.findMany({
            where: {
                status: {
                    in: [client_1.CustomOrderOutboxStatus.PENDING, client_1.CustomOrderOutboxStatus.FAILED],
                },
                availableAt: { lte: new Date() },
                attempts: { lt: MAX_NOTIFICATION_DISPATCH_ATTEMPTS },
            },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
        });
        let processedCount = 0;
        for (let index = 0; index < events.length; index += NOTIFICATION_DISPATCH_CONCURRENCY) {
            const chunk = events.slice(index, index + NOTIFICATION_DISPATCH_CONCURRENCY);
            const results = await Promise.all(chunk.map((event) => this.dispatchNotificationEvent(event)));
            processedCount += results.filter(Boolean).length;
        }
        return processedCount;
    }
    async dispatchNotificationEvent(event) {
        const claimed = await this.prisma.customOrderNotificationOutbox.updateMany({
            where: {
                id: event.id,
                status: event.status,
            },
            data: {
                status: client_1.CustomOrderOutboxStatus.PROCESSING,
                attempts: { increment: 1 },
                lastError: null,
            },
        });
        if (claimed.count === 0) {
            return false;
        }
        try {
            await this.notificationsQueue.enqueueFanout({
                recipientIds: [event.recipientId],
                notificationType: event.notificationType,
                actorId: event.actorId ?? undefined,
                payload: this.asRecord(event.payloadJson),
                target: this.asTarget(event.targetJson),
                dedupeMs: event.dedupeMs ?? undefined,
            });
            await this.prisma.customOrderNotificationOutbox.update({
                where: { id: event.id },
                data: {
                    status: client_1.CustomOrderOutboxStatus.COMPLETED,
                    processedAt: new Date(),
                    lastError: null,
                },
            });
            return true;
        }
        catch (error) {
            this.logger.warn(`Failed to dispatch custom-order notification ${event.id}: ${this.formatError(error)}`);
            const current = await this.prisma.customOrderNotificationOutbox.findUnique({
                where: { id: event.id },
                select: { attempts: true, customOrderId: true },
            });
            const exhausted = (current?.attempts ?? 0) >= MAX_NOTIFICATION_DISPATCH_ATTEMPTS;
            await this.prisma.customOrderNotificationOutbox.update({
                where: { id: event.id },
                data: {
                    status: client_1.CustomOrderOutboxStatus.FAILED,
                    lastError: exhausted
                        ? `DLQ_EXHAUSTED:${this.formatError(error)}`
                        : this.formatError(error),
                },
            });
            if (exhausted) {
                this.logger.error(`Custom-order notification outbox exhausted retries eventId=${event.id} customOrderId=${current?.customOrderId ?? 'unknown'}`);
            }
            return false;
        }
    }
    asRecord(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        return value;
    }
    asTarget(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        const record = value;
        if (typeof record.type !== 'string' || typeof record.id !== 'string') {
            return undefined;
        }
        return {
            type: record.type,
            id: record.id,
            preview: typeof record.preview === 'string' ? record.preview : undefined,
        };
    }
    formatError(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
};
exports.CustomOrderSideEffectsService = CustomOrderSideEffectsService;
exports.CustomOrderSideEffectsService = CustomOrderSideEffectsService = CustomOrderSideEffectsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_queue_service_1.NotificationsQueueService])
], CustomOrderSideEffectsService);
//# sourceMappingURL=custom-order-side-effects.service.js.map