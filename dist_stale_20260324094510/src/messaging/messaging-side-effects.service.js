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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var MessagingSideEffectsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingSideEffectsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../prisma/prisma.service");
const notifications_queue_service_1 = require("../queue/notifications.queue.service");
const events_gateway_1 = require("../realtime/events.gateway");
const schedule_1 = require("@nestjs/schedule");
const upload_service_1 = require("../upload/upload.service");
const MAX_MESSAGE_OUTBOX_ATTEMPTS = 8;
const UNREAD_REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MESSAGE_OUTBOX_COMPLETED_RETENTION_DAYS = 30;
const MESSAGE_OUTBOX_EXHAUSTED_RETENTION_DAYS = 90;
const MESSAGE_ORPHAN_UPLOAD_RETENTION_HOURS = 48;
const MESSAGE_THREAD_RETENTION_BATCH_SIZE = 200;
let MessagingSideEffectsService = MessagingSideEffectsService_1 = class MessagingSideEffectsService {
    constructor(prisma, notificationsQueue, events, uploadService) {
        this.prisma = prisma;
        this.notificationsQueue = notificationsQueue;
        this.events = events;
        this.uploadService = uploadService;
        this.logger = new common_1.Logger(MessagingSideEffectsService_1.name);
    }
    async dispatchMessageOutboxForMessage(messageId) {
        const rows = await this.prisma.messageNotificationOutbox.findMany({
            where: {
                messageId,
                status: { in: [client_1.MessageOutboxStatus.PENDING, client_1.MessageOutboxStatus.FAILED] },
                availableAt: { lte: new Date() },
                attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
            },
        });
        for (const row of rows) {
            const claim = await this.prisma.messageNotificationOutbox.updateMany({
                where: { id: row.id, status: row.status },
                data: { status: client_1.MessageOutboxStatus.PROCESSING, attempts: { increment: 1 }, lastError: null },
            });
            if (claim.count === 0)
                continue;
            try {
                await this.notificationsQueue.enqueueFanout({
                    recipientIds: [row.recipientId],
                    notificationType: row.notificationType,
                    payload: this.asRecord(row.payloadJson),
                });
                await this.prisma.messageNotificationOutbox.update({
                    where: { id: row.id },
                    data: { status: client_1.MessageOutboxStatus.COMPLETED, processedAt: new Date(), lastError: null },
                });
            }
            catch (error) {
                const current = await this.prisma.messageNotificationOutbox.findUnique({
                    where: { id: row.id },
                    select: { attempts: true, threadId: true },
                });
                const exhausted = (current?.attempts ?? 0) >= MAX_MESSAGE_OUTBOX_ATTEMPTS;
                await this.prisma.messageNotificationOutbox.update({
                    where: { id: row.id },
                    data: {
                        status: client_1.MessageOutboxStatus.FAILED,
                        lastError: exhausted
                            ? `DLQ_EXHAUSTED:${this.formatError(error)}`
                            : this.formatError(error),
                    },
                });
                if (exhausted) {
                    this.logger.error(`Messaging outbox exhausted retries rowId=${row.id} threadId=${current?.threadId ?? 'unknown'}`);
                }
            }
        }
    }
    async dispatchPendingMessageOutbox(batchSize = 100) {
        const rows = await this.prisma.messageNotificationOutbox.findMany({
            where: {
                status: { in: [client_1.MessageOutboxStatus.PENDING, client_1.MessageOutboxStatus.FAILED] },
                availableAt: { lte: new Date() },
                attempts: { lt: MAX_MESSAGE_OUTBOX_ATTEMPTS },
            },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
        });
        const uniqueMessageIds = Array.from(new Set(rows.map((row) => row.messageId)));
        for (const messageId of uniqueMessageIds) {
            await this.dispatchMessageOutboxForMessage(messageId);
        }
    }
    async enqueueUnreadMessageReminders(batchSize = 300) {
        const now = new Date();
        const participants = await this.prisma.messageThreadParticipant.findMany({
            where: {
                thread: {
                    lastMessageAt: { not: null },
                    status: { in: [client_1.MessageThreadStatus.OPEN, client_1.MessageThreadStatus.READ_ONLY] },
                },
            },
            select: {
                threadId: true,
                userId: true,
                role: true,
                lastReadAt: true,
                thread: {
                    select: {
                        id: true,
                        contextType: true,
                        orderId: true,
                        customOrderId: true,
                        brandId: true,
                        lastMessageAt: true,
                        lastMessageId: true,
                        lastSenderUserId: true,
                    },
                },
            },
            take: batchSize,
            orderBy: { joinedAt: 'asc' },
        });
        const participantKeys = participants.map((participant) => ({
            threadId: participant.threadId,
            recipientId: participant.userId,
        }));
        const recentReminders = participantKeys.length
            ? await this.prisma.messageNotificationOutbox.findMany({
                where: {
                    notificationType: client_1.NotificationType.MESSAGE_UNREAD_REMINDER,
                    createdAt: { gt: new Date(now.getTime() - UNREAD_REMINDER_COOLDOWN_MS) },
                    OR: participantKeys.map((key) => ({
                        threadId: key.threadId,
                        recipientId: key.recipientId,
                    })),
                },
                select: {
                    threadId: true,
                    recipientId: true,
                },
            })
            : [];
        const recentlyReminded = new Set(recentReminders.map((row) => `${row.threadId}:${row.recipientId}`));
        for (const participant of participants) {
            const lastMessageAt = participant.thread.lastMessageAt;
            if (!lastMessageAt)
                continue;
            if (participant.thread.lastSenderUserId === participant.userId)
                continue;
            if (participant.lastReadAt && participant.lastReadAt >= lastMessageAt)
                continue;
            const reminderKey = `${participant.threadId}:${participant.userId}`;
            if (recentlyReminded.has(reminderKey))
                continue;
            await this.prisma.messageNotificationOutbox.create({
                data: {
                    threadId: participant.threadId,
                    messageId: participant.thread.lastMessageId ?? participant.threadId,
                    recipientId: participant.userId,
                    notificationType: client_1.NotificationType.MESSAGE_UNREAD_REMINDER,
                    payloadJson: {
                        threadId: participant.thread.id,
                        contextType: participant.thread.contextType,
                        orderId: participant.thread.orderId,
                        customOrderId: participant.thread.customOrderId,
                        targetUrl: this.resolveThreadTargetUrl(participant.thread.contextType, participant.thread.orderId, participant.thread.customOrderId, participant.thread.brandId, participant.role),
                    },
                },
            });
            recentlyReminded.add(reminderKey);
        }
    }
    async cleanupMessageOutboxRows() {
        const now = Date.now();
        const completedBefore = new Date(now - MESSAGE_OUTBOX_COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const exhaustedBefore = new Date(now - MESSAGE_OUTBOX_EXHAUSTED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await this.prisma.messageNotificationOutbox.deleteMany({
            where: {
                status: client_1.MessageOutboxStatus.COMPLETED,
                processedAt: { lt: completedBefore },
            },
        });
        await this.prisma.messageNotificationOutbox.deleteMany({
            where: {
                status: client_1.MessageOutboxStatus.FAILED,
                lastError: { startsWith: 'DLQ_EXHAUSTED:' },
                updatedAt: { lt: exhaustedBefore },
            },
        });
    }
    async cleanupOrphanedMessageUploads(batchSize = 100) {
        const cutoff = new Date(Date.now() - MESSAGE_ORPHAN_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000);
        const orphanFiles = await this.prisma.fileUpload.findMany({
            where: {
                fileType: { in: [client_1.FileType.MESSAGE_IMAGE, client_1.FileType.MESSAGE_DOCUMENT] },
                createdAt: { lt: cutoff },
                messageAttachments: { none: {} },
            },
            select: { id: true, userId: true },
            take: batchSize,
            orderBy: { createdAt: 'asc' },
        });
        for (const file of orphanFiles) {
            try {
                await this.uploadService.deleteFile(file.id, file.userId);
            }
            catch (error) {
                this.logger.warn(`Failed deleting orphaned message upload fileId=${file.id}: ${this.formatError(error)}`);
            }
        }
    }
    async cleanupExpiredClosedThreads(batchSize = MESSAGE_THREAD_RETENTION_BATCH_SIZE) {
        const now = new Date();
        const eligibleThreads = await this.prisma.messageThread.findMany({
            where: {
                contextType: client_1.MessageContextType.CUSTOM_ORDER,
                status: { in: [client_1.MessageThreadStatus.READ_ONLY, client_1.MessageThreadStatus.ARCHIVED] },
                archivedAt: null,
                customOrder: {
                    is: {
                        measurementRetentionUntil: { lt: now },
                        OR: [
                            { retentionHoldType: null },
                            { retentionHoldUntil: { lte: now } },
                        ],
                    },
                },
            },
            select: { id: true },
            take: batchSize,
            orderBy: { updatedAt: 'asc' },
        });
        if (eligibleThreads.length === 0) {
            return;
        }
        const threadIds = eligibleThreads.map((thread) => thread.id);
        await this.prisma.$transaction(async (tx) => {
            await tx.message.updateMany({
                where: {
                    threadId: { in: threadIds },
                    kind: client_1.MessageKind.USER,
                    OR: [{ bodyText: { not: null } }, { senderUserId: { not: null } }],
                },
                data: {
                    bodyText: null,
                    senderUserId: null,
                    visibilityState: client_1.MessageVisibilityState.REDACTED,
                    moderatedAt: now,
                    moderationReason: 'RETENTION_EXPIRED',
                },
            });
            await tx.messageThread.updateMany({
                where: { id: { in: threadIds } },
                data: {
                    status: client_1.MessageThreadStatus.ARCHIVED,
                    archivedAt: now,
                },
            });
        });
        this.logger.log(`Archived and anonymized ${threadIds.length} expired messaging threads`);
    }
    emitThreadInvalidation(thread, recipientIds) {
        const uniqueRecipientIds = Array.from(new Set(recipientIds.filter(Boolean)));
        for (const recipientId of uniqueRecipientIds) {
            this.events?.server?.to(`USER:${recipientId}`).emit('thread.updated', {
                threadId: thread.id,
                contextType: thread.contextType,
                orderId: thread.orderId,
                customOrderId: thread.customOrderId,
                ts: Date.now(),
            });
        }
    }
    emitMessageCreated(thread, recipientIds, message) {
        const uniqueRecipientIds = Array.from(new Set(recipientIds.filter(Boolean)));
        for (const recipientId of uniqueRecipientIds) {
            this.events?.server?.to(`USER:${recipientId}`).emit('message.created', {
                threadId: thread.id,
                messageId: message.id,
                senderRole: message.senderRole,
                createdAt: message.createdAt,
                contextType: thread.contextType,
                orderId: thread.orderId,
                customOrderId: thread.customOrderId,
                ts: Date.now(),
            });
        }
    }
    emitMessageRead(thread, actorId, lastReadMessageId) {
        this.events?.server?.to(`USER:${actorId}`).emit('message.read', {
            threadId: thread.id,
            contextType: thread.contextType,
            orderId: thread.orderId,
            customOrderId: thread.customOrderId,
            lastReadMessageId,
            ts: Date.now(),
        });
    }
    asRecord(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }
        return value;
    }
    formatError(error) {
        if (error instanceof Error)
            return error.message;
        return String(error);
    }
    resolveThreadTargetUrl(contextType, orderId, customOrderId, brandId, recipientRole) {
        if (contextType === client_1.MessageContextType.CUSTOM_ORDER && customOrderId) {
            if (recipientRole === client_1.MessageParticipantRole.BRAND_OWNER) {
                return `/studio/custom-orders/${customOrderId}#messages`;
            }
            if (recipientRole === client_1.MessageParticipantRole.ADMIN) {
                return `/admin/custom-orders/${customOrderId}#messages`;
            }
            return `/custom-orders/${customOrderId}#messages`;
        }
        if (contextType === client_1.MessageContextType.STANDARD_ORDER && orderId) {
            if (recipientRole === client_1.MessageParticipantRole.BRAND_OWNER && brandId) {
                return `/brands/${brandId}/orders/${orderId}#messages`;
            }
            return `/orders/access/${orderId}#messages`;
        }
        return '/settings?tab=notifications';
    }
};
exports.MessagingSideEffectsService = MessagingSideEffectsService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_MINUTE),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MessagingSideEffectsService.prototype, "dispatchPendingMessageOutbox", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_30_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MessagingSideEffectsService.prototype, "enqueueUnreadMessageReminders", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_3AM),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], MessagingSideEffectsService.prototype, "cleanupMessageOutboxRows", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_4AM),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MessagingSideEffectsService.prototype, "cleanupOrphanedMessageUploads", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_5AM),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], MessagingSideEffectsService.prototype, "cleanupExpiredClosedThreads", null);
exports.MessagingSideEffectsService = MessagingSideEffectsService = MessagingSideEffectsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_queue_service_1.NotificationsQueueService,
        events_gateway_1.EventsGateway,
        upload_service_1.UploadService])
], MessagingSideEffectsService);
//# sourceMappingURL=messaging-side-effects.service.js.map