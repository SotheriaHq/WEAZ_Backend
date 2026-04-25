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
var CustomOrderOpsCronService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrderOpsCronService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const schedule_1 = require("@nestjs/schedule");
const custom_order_refund_service_1 = require("../custom-orders/custom-order-refund.service");
const custom_order_side_effects_service_1 = require("../custom-orders/custom-order-side-effects.service");
const prisma_service_1 = require("../prisma/prisma.service");
const ACCEPTANCE_SLA_WARNING_HOURS = 24;
const ACCEPTANCE_TIMEOUT_HOURS = 48;
const STALE_STAGE_ESCALATION_HOURS = 24;
const ACCEPTANCE_WINDOW_REMINDER_HOURS = 12;
let CustomOrderOpsCronService = CustomOrderOpsCronService_1 = class CustomOrderOpsCronService {
    constructor(prisma, sideEffects, refundService) {
        this.prisma = prisma;
        this.sideEffects = sideEffects;
        this.refundService = refundService;
        this.logger = new common_1.Logger(CustomOrderOpsCronService_1.name);
    }
    async processDurableCustomOrderSideEffects() {
        try {
            const [syncedAnalyticsCount, dispatchedNotificationsCount] = await Promise.all([
                this.sideEffects.syncTimelineAnalytics(),
                this.sideEffects.dispatchPendingNotifications(),
            ]);
            if (syncedAnalyticsCount > 0 || dispatchedNotificationsCount > 0) {
                this.logger.log(`Processed custom-order side effects: analytics=${syncedAnalyticsCount}, notifications=${dispatchedNotificationsCount}`);
            }
        }
        catch (error) {
            this.logger.warn(`Durable custom-order side effects cron failed: ${this.formatError(error)}`);
        }
    }
    async processAcceptanceSlaRisk() {
        const now = new Date();
        const warningThreshold = new Date(now.getTime() - ACCEPTANCE_SLA_WARNING_HOURS * 60 * 60 * 1000);
        const timeoutThreshold = new Date(now.getTime() - ACCEPTANCE_TIMEOUT_HOURS * 60 * 60 * 1000);
        try {
            const orders = await this.prisma.customOrder.findMany({
                where: {
                    status: client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
                    paymentStatus: 'PAID',
                    acceptedAt: null,
                    createdAt: {
                        lte: warningThreshold,
                        gt: timeoutThreshold,
                    },
                },
                select: {
                    id: true,
                    buyerId: true,
                    brandId: true,
                    createdAt: true,
                },
                take: 200,
            });
            for (const order of orders) {
                const hoursWaiting = Math.max(ACCEPTANCE_SLA_WARNING_HOURS, Math.floor((now.getTime() - order.createdAt.getTime()) / (60 * 60 * 1000)));
                await this.sideEffects.enqueueNotification({
                    customOrderId: order.id,
                    recipientIds: [order.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
                    target: this.customOrderTarget(order.id),
                    payload: { customOrderId: order.id, hoursWaiting },
                    dedupeMs: 18 * 60 * 60 * 1000,
                });
                await this.notifyBrandOwner(order.brandId, order.id, {
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
                    payload: { customOrderId: order.id, hoursWaiting },
                    target: this.customOrderTarget(order.id),
                    dedupeMs: 18 * 60 * 60 * 1000,
                });
            }
            if (orders.length > 0) {
                this.logger.log(`Flagged ${orders.length} custom order(s) at acceptance SLA risk`);
            }
        }
        catch (error) {
            this.logger.warn(`Acceptance SLA cron failed: ${this.formatError(error)}`);
        }
    }
    async escalateAcceptanceTimeouts() {
        const now = new Date();
        const timeoutThreshold = new Date(now.getTime() - ACCEPTANCE_TIMEOUT_HOURS * 60 * 60 * 1000);
        try {
            const admins = await this.getActiveAdminIds();
            const orders = await this.prisma.customOrder.findMany({
                where: {
                    status: client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
                    paymentStatus: 'PAID',
                    acceptedAt: null,
                    createdAt: { lte: timeoutThreshold },
                },
                select: {
                    id: true,
                    buyerId: true,
                    brandId: true,
                },
                take: 100,
            });
            for (const order of orders) {
                const escalated = await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.customOrder.updateMany({
                        where: {
                            id: order.id,
                            status: client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
                            acceptedAt: null,
                        },
                        data: {
                            status: client_1.CustomOrderStatus.REFUND_IN_PROGRESS,
                        },
                    });
                    if (updated.count === 0) {
                        return false;
                    }
                    await tx.customOrderTimelineEvent.create({
                        data: {
                            customOrderId: order.id,
                            actorType: client_1.CustomOrderActorType.SYSTEM,
                            eventType: 'REFUND_INITIATED',
                            payloadJson: {
                                reason: 'BRAND_ACCEPTANCE_TIMEOUT',
                                autoEscalated: true,
                            },
                        },
                    });
                    await this.refundService.initiateRefund(tx, {
                        customOrderId: order.id,
                        reason: 'BRAND_ACCEPTANCE_TIMEOUT',
                        actorType: client_1.CustomOrderActorType.SYSTEM,
                    });
                    return true;
                });
                if (!escalated) {
                    continue;
                }
                await this.sideEffects.enqueueNotification({
                    customOrderId: order.id,
                    recipientIds: [order.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
                    target: this.customOrderTarget(order.id),
                    payload: {
                        customOrderId: order.id,
                        reason: 'BRAND_ACCEPTANCE_TIMEOUT',
                    },
                });
                if (admins.length > 0) {
                    await this.sideEffects.enqueueNotification({
                        customOrderId: order.id,
                        recipientIds: admins,
                        notificationType: client_1.NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
                        target: this.adminCustomOrderTarget(order.id),
                        payload: {
                            customOrderId: order.id,
                            reason: 'BRAND_ACCEPTANCE_TIMEOUT',
                        },
                        dedupeMs: 12 * 60 * 60 * 1000,
                    });
                }
            }
            if (orders.length > 0) {
                this.logger.log(`Escalated ${orders.length} custom order(s) for acceptance timeout`);
            }
        }
        catch (error) {
            this.logger.warn(`Acceptance timeout cron failed: ${this.formatError(error)}`);
        }
    }
    async remindAcceptanceWindowDeadline() {
        const now = new Date();
        const reminderThreshold = new Date(now.getTime() + ACCEPTANCE_WINDOW_REMINDER_HOURS * 60 * 60 * 1000);
        try {
            const orders = await this.prisma.customOrder.findMany({
                where: {
                    status: client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
                    buyerAcceptanceWindowEndsAt: {
                        gt: now,
                        lte: reminderThreshold,
                    },
                },
                select: {
                    id: true,
                    buyerId: true,
                    buyerAcceptanceWindowEndsAt: true,
                },
                take: 200,
            });
            for (const order of orders) {
                const hoursRemaining = Math.max(1, Math.ceil((order.buyerAcceptanceWindowEndsAt.getTime() - now.getTime()) /
                    (60 * 60 * 1000)));
                await this.sideEffects.enqueueNotification({
                    customOrderId: order.id,
                    recipientIds: [order.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER,
                    target: this.customOrderTarget(order.id),
                    payload: { customOrderId: order.id, hoursRemaining },
                    dedupeMs: 10 * 60 * 60 * 1000,
                });
            }
            if (orders.length > 0) {
                this.logger.log(`Queued ${orders.length} custom order acceptance reminder(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Acceptance reminder cron failed: ${this.formatError(error)}`);
        }
    }
    async autoCompleteExpiredAcceptanceWindows() {
        const now = new Date();
        try {
            const orders = await this.prisma.customOrder.findMany({
                where: {
                    status: client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
                    buyerAcceptanceWindowEndsAt: { lte: now },
                    issues: { none: {} },
                    disputes: {
                        none: {
                            status: {
                                in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'],
                            },
                        },
                    },
                },
                select: {
                    id: true,
                    buyerId: true,
                    brandId: true,
                },
                take: 100,
            });
            for (const order of orders) {
                await this.prisma.$transaction(async (tx) => {
                    const updated = await tx.customOrder.updateMany({
                        where: {
                            id: order.id,
                            status: client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
                        },
                        data: {
                            status: client_1.CustomOrderStatus.COMPLETED,
                            buyerAcceptedAt: now,
                            completedAt: now,
                        },
                    });
                    if (updated.count === 0) {
                        return;
                    }
                    await tx.customOrderTimelineEvent.create({
                        data: {
                            customOrderId: order.id,
                            actorType: client_1.CustomOrderActorType.SYSTEM,
                            eventType: 'BUYER_CONFIRMED_DELIVERY',
                            payloadJson: { autoCompleted: true },
                        },
                    });
                    await tx.customOrderLedgerAllocation.updateMany({
                        where: {
                            customOrderId: order.id,
                            allocationType: client_1.CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
                            status: client_1.CustomOrderLedgerAllocationStatus.HELD,
                        },
                        data: {
                            status: client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                            eligibleAt: now,
                        },
                    });
                });
                await this.sideEffects.enqueueNotification({
                    customOrderId: order.id,
                    recipientIds: [order.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
                    target: this.customOrderTarget(order.id),
                    payload: {
                        customOrderId: order.id,
                        status: client_1.CustomOrderStatus.COMPLETED,
                        autoCompleted: true,
                    },
                    dedupeMs: 60 * 1000,
                });
                await this.notifyBrandOwner(order.brandId, order.id, {
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
                    target: this.adminCustomOrderTarget(order.id),
                    payload: {
                        customOrderId: order.id,
                        status: client_1.CustomOrderStatus.COMPLETED,
                        autoCompleted: true,
                    },
                    dedupeMs: 60 * 1000,
                });
            }
            if (orders.length > 0) {
                this.logger.log(`Auto-completed ${orders.length} delivered custom order(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Acceptance window completion cron failed: ${this.formatError(error)}`);
        }
    }
    async warnOnStaleProgressStages() {
        const now = new Date();
        try {
            const events = await this.prisma.customOrderProgressEvent.findMany({
                where: {
                    staleThresholdAt: { lte: now },
                    staleBuyerWarnedAt: null,
                    customOrder: {
                        status: {
                            in: [
                                client_1.CustomOrderStatus.ACCEPTED,
                                client_1.CustomOrderStatus.IN_PRODUCTION,
                                client_1.CustomOrderStatus.READY_FOR_DISPATCH,
                                client_1.CustomOrderStatus.IN_TRANSIT,
                            ],
                        },
                    },
                },
                select: {
                    id: true,
                    stage: true,
                    customOrder: {
                        select: {
                            id: true,
                            buyerId: true,
                        },
                    },
                },
                take: 200,
            });
            for (const event of events) {
                await this.prisma.customOrderProgressEvent.update({
                    where: { id: event.id },
                    data: { staleBuyerWarnedAt: now },
                });
                await this.sideEffects.enqueueNotification({
                    customOrderId: event.customOrder.id,
                    recipientIds: [event.customOrder.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
                    target: this.customOrderTarget(event.customOrder.id),
                    payload: {
                        customOrderId: event.customOrder.id,
                        stage: event.stage,
                    },
                    dedupeMs: 12 * 60 * 60 * 1000,
                });
            }
            if (events.length > 0) {
                this.logger.log(`Warned buyers on ${events.length} stale custom order stage(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Stale stage warning cron failed: ${this.formatError(error)}`);
        }
    }
    async escalatePersistentlyStaleStages() {
        const now = new Date();
        const escalationThreshold = new Date(now.getTime() - STALE_STAGE_ESCALATION_HOURS * 60 * 60 * 1000);
        try {
            const admins = await this.getActiveAdminIds();
            const events = await this.prisma.customOrderProgressEvent.findMany({
                where: {
                    staleBuyerWarnedAt: { lte: escalationThreshold },
                    adminEscalatedAt: null,
                    customOrder: {
                        status: {
                            in: [
                                client_1.CustomOrderStatus.ACCEPTED,
                                client_1.CustomOrderStatus.IN_PRODUCTION,
                                client_1.CustomOrderStatus.READY_FOR_DISPATCH,
                                client_1.CustomOrderStatus.IN_TRANSIT,
                            ],
                        },
                    },
                },
                select: {
                    id: true,
                    stage: true,
                    customOrder: {
                        select: {
                            id: true,
                            buyerId: true,
                        },
                    },
                },
                take: 200,
            });
            for (const event of events) {
                await this.prisma.$transaction(async (tx) => {
                    await tx.customOrderProgressEvent.update({
                        where: { id: event.id },
                        data: { adminEscalatedAt: now },
                    });
                    await tx.customOrderTimelineEvent.create({
                        data: {
                            customOrderId: event.customOrder.id,
                            actorType: client_1.CustomOrderActorType.SYSTEM,
                            eventType: 'ADMIN_ESCALATED',
                            payloadJson: {
                                reason: 'STALE_STAGE',
                                stage: event.stage,
                            },
                        },
                    });
                });
                await this.sideEffects.enqueueNotification({
                    customOrderId: event.customOrder.id,
                    recipientIds: [event.customOrder.buyerId],
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
                    target: this.customOrderTarget(event.customOrder.id),
                    payload: {
                        customOrderId: event.customOrder.id,
                        reason: 'STALE_STAGE',
                        stage: event.stage,
                    },
                    dedupeMs: 12 * 60 * 60 * 1000,
                });
                if (admins.length > 0) {
                    await this.sideEffects.enqueueNotification({
                        customOrderId: event.customOrder.id,
                        recipientIds: admins,
                        notificationType: client_1.NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
                        target: this.adminCustomOrderTarget(event.customOrder.id),
                        payload: {
                            customOrderId: event.customOrder.id,
                            reason: 'STALE_STAGE',
                            stage: event.stage,
                        },
                        dedupeMs: 12 * 60 * 60 * 1000,
                    });
                }
            }
            if (events.length > 0) {
                this.logger.log(`Escalated ${events.length} persistently stale custom order stage(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Stale stage escalation cron failed: ${this.formatError(error)}`);
        }
    }
    async cleanupExpiredCheckoutIntents() {
        try {
            const result = await this.prisma.customOrderCheckoutIntent.deleteMany({
                where: {
                    consumedAt: null,
                    expiresAt: { lt: new Date() },
                },
            });
            if (result.count > 0) {
                this.logger.log(`Deleted ${result.count} expired custom order checkout intent(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Checkout intent cleanup cron failed: ${this.formatError(error)}`);
        }
    }
    async anonymizeExpiredMeasurements() {
        const now = new Date();
        try {
            const result = await this.prisma.customOrder.updateMany({
                where: {
                    anonymizedAt: null,
                    measurementRetentionUntil: { lt: now },
                    status: {
                        in: [
                            client_1.CustomOrderStatus.COMPLETED,
                            client_1.CustomOrderStatus.CLOSED,
                            client_1.CustomOrderStatus.REJECTED_BY_BRAND,
                            client_1.CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
                        ],
                    },
                    issues: { none: {} },
                    disputes: { none: {} },
                    OR: [
                        { retentionHoldType: null },
                        { retentionHoldUntil: { lte: now } },
                    ],
                },
                data: {
                    measurementSnapshotJson: {},
                    contactInfoJson: {},
                    anonymizedAt: now,
                },
            });
            if (result.count > 0) {
                this.logger.log(`Anonymized measurements for ${result.count} custom order(s)`);
            }
        }
        catch (error) {
            this.logger.warn(`Measurement anonymization cron failed: ${this.formatError(error)}`);
        }
    }
    async queueEligibleCustomOrderPayouts() {
        try {
            const now = new Date();
            const allocations = await this.prisma.customOrderLedgerAllocation.findMany({
                where: {
                    status: client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                    paidOutAt: null,
                    customOrder: {
                        status: {
                            in: [client_1.CustomOrderStatus.ACCEPTED, client_1.CustomOrderStatus.COMPLETED, client_1.CustomOrderStatus.CLOSED],
                        },
                        disputes: {
                            none: {
                                status: {
                                    in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'],
                                },
                            },
                        },
                    },
                },
                select: {
                    id: true,
                    customOrderId: true,
                    customOrder: {
                        select: {
                            brandId: true,
                            buyerId: true,
                        },
                    },
                },
                take: 500,
            });
            if (allocations.length === 0) {
                return;
            }
            const admins = await this.getActiveAdminIds();
            if (admins.length === 0) {
                return;
            }
            const orderIds = Array.from(new Set(allocations.map((allocation) => allocation.customOrderId)));
            for (const customOrderId of orderIds) {
                await this.sideEffects.enqueueNotification({
                    customOrderId,
                    recipientIds: admins,
                    notificationType: client_1.NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
                    target: this.adminCustomOrderTarget(customOrderId),
                    payload: {
                        customOrderId,
                        reason: 'PAYOUT_RELEASE_ELIGIBLE',
                        requiresManualRelease: true,
                        generatedAt: now.toISOString(),
                    },
                    dedupeMs: 4 * 60 * 60 * 1000,
                });
                await this.prisma.customOrderTimelineEvent.create({
                    data: {
                        customOrderId,
                        actorType: client_1.CustomOrderActorType.SYSTEM,
                        eventType: 'ADMIN_ESCALATED',
                        payloadJson: {
                            reason: 'PAYOUT_RELEASE_ELIGIBLE',
                            requiresManualRelease: true,
                        },
                    },
                });
            }
            if (orderIds.length > 0) {
                this.logger.log(`Queued ${orderIds.length} custom-order manual payout release alert(s) for admin action`);
            }
        }
        catch (error) {
            this.logger.warn(`Custom-order payout queue cron failed: ${this.formatError(error)}`);
        }
    }
    customOrderTarget(customOrderId) {
        return {
            type: 'SYSTEM',
            id: `custom-order:${customOrderId}`,
            preview: `/custom-orders/${customOrderId}`,
        };
    }
    adminCustomOrderTarget(customOrderId) {
        return {
            type: 'SYSTEM',
            id: `admin-custom-order:${customOrderId}`,
            preview: `/admin/custom-orders/${customOrderId}`,
        };
    }
    async notifyBrandOwner(brandId, customOrderId, options) {
        const brand = await this.prisma.brand.findUnique({
            where: { id: brandId },
            select: { ownerId: true },
        });
        if (!brand?.ownerId) {
            return;
        }
        await this.sideEffects.enqueueNotification({
            customOrderId,
            recipientIds: [brand.ownerId],
            notificationType: options.notificationType,
            payload: options.payload,
            target: options.target,
            dedupeMs: options.dedupeMs,
        });
    }
    async getActiveAdminIds() {
        const admins = await this.prisma.user.findMany({
            where: {
                role: { in: [client_1.Role.Admin, client_1.Role.SuperAdmin] },
                status: client_1.UserStatus.ACTIVE,
            },
            select: { id: true },
            take: 50,
        });
        return admins.map((admin) => admin.id);
    }
    formatError(error) {
        return error instanceof Error ? error.message : String(error);
    }
};
exports.CustomOrderOpsCronService = CustomOrderOpsCronService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_MINUTE),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "processDurableCustomOrderSideEffects", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "processAcceptanceSlaRisk", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "escalateAcceptanceTimeouts", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "remindAcceptanceWindowDeadline", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "autoCompleteExpiredAcceptanceWindows", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_6_HOURS),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "warnOnStaleProgressStages", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_6_HOURS),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "escalatePersistentlyStaleStages", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_HOUR),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "cleanupExpiredCheckoutIntents", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_DAY_AT_1AM),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "anonymizeExpiredMeasurements", null);
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_6_HOURS),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderOpsCronService.prototype, "queueEligibleCustomOrderPayouts", null);
exports.CustomOrderOpsCronService = CustomOrderOpsCronService = CustomOrderOpsCronService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        custom_order_side_effects_service_1.CustomOrderSideEffectsService,
        custom_order_refund_service_1.CustomOrderRefundService])
], CustomOrderOpsCronService);
//# sourceMappingURL=custom-order-ops.cron.service.js.map