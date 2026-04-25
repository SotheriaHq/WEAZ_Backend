import { Injectable, Logger } from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderCheckoutStatus,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  NotificationType,
  PaymentSubjectType,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomOrdersPaymentsService } from 'src/custom-orders/custom-orders-payments.service';
import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { PaymentRuntimeHealthService } from 'src/payment/payment-runtime-health.service';
import { PrismaService } from 'src/prisma/prisma.service';

const ACCEPTANCE_SLA_WARNING_HOURS = 24;
const ACCEPTANCE_TIMEOUT_HOURS = 48;
const STALE_STAGE_ESCALATION_HOURS = 24;
const ACCEPTANCE_WINDOW_REMINDER_HOURS = 12;
const STALE_OPERATIONAL_STATUS_WARNING_HOURS = 24;
const PAYMENT_RECONCILIATION_LOOKBACK_HOURS = 24 * 14;
const PAYMENT_RECONCILIATION_REVERIFY_MINUTES = 15;
const PAYMENT_RECONCILIATION_BATCH_SIZE = 100;

@Injectable()
export class CustomOrderOpsCronService {
  private readonly logger = new Logger(CustomOrderOpsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly refundService: CustomOrderRefundService,
    private readonly customOrdersPaymentsService: CustomOrdersPaymentsService,
    private readonly paymentRuntimeHealthService: PaymentRuntimeHealthService,
  ) { }

  @Cron(CronExpression.EVERY_MINUTE)
  async processDurableCustomOrderSideEffects(): Promise<void> {
    try {
      const [syncedAnalyticsCount, dispatchedNotificationsCount] = await Promise.all([
        this.sideEffects.syncTimelineAnalytics(),
        this.sideEffects.dispatchPendingNotifications(),
      ]);

      if (syncedAnalyticsCount > 0 || dispatchedNotificationsCount > 0) {
        this.logger.log(
          `Processed custom-order side effects: analytics=${syncedAnalyticsCount}, notifications=${dispatchedNotificationsCount}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Durable custom-order side effects cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcilePendingCustomOrderPayments(): Promise<void> {
    const now = new Date();
    const reverifyBefore = new Date(
      now.getTime() - PAYMENT_RECONCILIATION_REVERIFY_MINUTES * 60 * 1000,
    );
    const lookbackStart = new Date(
      now.getTime() - PAYMENT_RECONCILIATION_LOOKBACK_HOURS * 60 * 60 * 1000,
    );

    try {
      const attempts = await this.prisma.paymentAttempt.findMany({
        where: {
          subjectType: PaymentSubjectType.CUSTOM_ORDER,
          providerMode: 'live',
          status: {
            in: ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'],
          },
          buyerId: { not: null },
          createdAt: { gte: lookbackStart },
          OR: [
            { lastVerifiedAt: null },
            { lastVerifiedAt: { lte: reverifyBefore } },
          ],
        },
        select: {
          reference: true,
          buyerId: true,
          provider: true,
        },
        orderBy: [{ lastVerifiedAt: 'asc' }, { createdAt: 'desc' }],
        take: PAYMENT_RECONCILIATION_BATCH_SIZE,
      });

      if (attempts.length === 0) {
        await this.paymentRuntimeHealthService.recordCronHeartbeat(
          'custom-order-payment-reconcile',
          'ok',
          {
            scanned: 0,
            paid: 0,
            unresolved: 0,
            failed: 0,
          },
        );
        return;
      }

      let paid = 0;
      let unresolved = 0;
      let failed = 0;

      for (const attempt of attempts) {
        const buyerId = String(attempt.buyerId ?? '').trim();
        if (!buyerId) {
          failed += 1;
          continue;
        }

        try {
          const verification = await this.customOrdersPaymentsService.verifyPaymentByReference(
            buyerId,
            {
              reference: attempt.reference,
              gateway: String(attempt.provider || 'PAYSTACK'),
            },
          );

          if (verification.status === 'PAID') {
            paid += 1;
          } else {
            unresolved += 1;
          }
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `Custom-order payment reconciliation failed for ${attempt.reference}: ${this.formatError(error)}`,
          );
        }
      }

      this.logger.log(
        `Custom-order payment reconciliation processed ${attempts.length} attempt(s): paid=${paid}, unresolved=${unresolved}, failed=${failed}`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'custom-order-payment-reconcile',
        'ok',
        {
          scanned: attempts.length,
          paid,
          unresolved,
          failed,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Custom-order payment reconciliation cron failed: ${this.formatError(error)}`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'custom-order-payment-reconcile',
        'error',
        {
          error: this.formatError(error),
        },
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async notifyOnStaleOperationalStatuses(): Promise<void> {
    const now = new Date();
    const warningThreshold = new Date(
      now.getTime() - STALE_OPERATIONAL_STATUS_WARNING_HOURS * 60 * 60 * 1000,
    );

    try {
      const admins = await this.getActiveAdminIds();
      const orders = await this.prisma.customOrder.findMany({
        where: {
          status: {
            in: [
              CustomOrderStatus.ACCEPTED,
              CustomOrderStatus.IN_PRODUCTION,
              CustomOrderStatus.READY_FOR_DISPATCH,
              CustomOrderStatus.IN_TRANSIT,
            ],
          },
          lastBrandProgressUpdateAt: { lte: warningThreshold },
        },
        select: {
          id: true,
          buyerId: true,
          brandId: true,
          status: true,
          lastBrandProgressUpdateAt: true,
        },
        take: 200,
      });

      for (const order of orders) {
        const hoursWaiting = Math.max(
          STALE_OPERATIONAL_STATUS_WARNING_HOURS,
          Math.floor(
            (now.getTime() - order.lastBrandProgressUpdateAt.getTime()) /
              (60 * 60 * 1000),
          ),
        );

        await this.sideEffects.enqueueNotification({
          customOrderId: order.id,
          recipientIds: [order.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
          target: this.customOrderTarget(order.id),
          payload: {
            customOrderId: order.id,
            status: order.status,
            hoursWaiting,
          },
          dedupeMs: 18 * 60 * 60 * 1000,
        });

        await this.notifyBrandOwner(order.brandId, order.id, {
          notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
          payload: {
            customOrderId: order.id,
            status: order.status,
            hoursWaiting,
            reason: 'STALE_OPERATIONAL_STATUS',
          },
          target: this.studioCustomOrderTarget(order.id),
          dedupeMs: 18 * 60 * 60 * 1000,
        });

        if (admins.length > 0) {
          await this.sideEffects.enqueueNotification({
            customOrderId: order.id,
            recipientIds: admins,
            notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
            target: this.adminCustomOrderTarget(order.id),
            payload: {
              customOrderId: order.id,
              status: order.status,
              hoursWaiting,
              reason: 'STALE_OPERATIONAL_STATUS',
            },
            dedupeMs: 18 * 60 * 60 * 1000,
          });
        }
      }

      if (orders.length > 0) {
        this.logger.log(
          `Queued ${orders.length} stale operational custom-order reminder(s) for buyer, brand, and admin`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Operational stale-status cron failed: ${this.formatError(error)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async processAcceptanceSlaRisk(): Promise<void> {
    const now = new Date();
    const warningThreshold = new Date(
      now.getTime() - ACCEPTANCE_SLA_WARNING_HOURS * 60 * 60 * 1000,
    );
    const timeoutThreshold = new Date(
      now.getTime() - ACCEPTANCE_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    try {
      const orders = await this.prisma.customOrder.findMany({
        where: {
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
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
        const hoursWaiting = Math.max(
          ACCEPTANCE_SLA_WARNING_HOURS,
          Math.floor((now.getTime() - order.createdAt.getTime()) / (60 * 60 * 1000)),
        );

        await this.sideEffects.enqueueNotification({
          customOrderId: order.id,
          recipientIds: [order.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
          target: this.customOrderTarget(order.id),
          payload: { customOrderId: order.id, hoursWaiting },
          dedupeMs: 18 * 60 * 60 * 1000,
        });

        await this.notifyBrandOwner(order.brandId, order.id, {
          notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
          payload: { customOrderId: order.id, hoursWaiting },
          target: this.customOrderTarget(order.id),
          dedupeMs: 18 * 60 * 60 * 1000,
        });
      }

      if (orders.length > 0) {
        this.logger.log(`Flagged ${orders.length} custom order(s) at acceptance SLA risk`);
      }
    } catch (error) {
      this.logger.warn(`Acceptance SLA cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async escalateAcceptanceTimeouts(): Promise<void> {
    const now = new Date();
    const timeoutThreshold = new Date(
      now.getTime() - ACCEPTANCE_TIMEOUT_HOURS * 60 * 60 * 1000,
    );

    try {
      const admins = await this.getActiveAdminIds();
      const orders = await this.prisma.customOrder.findMany({
        where: {
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
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
              status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
              acceptedAt: null,
            },
            data: {
              status: CustomOrderStatus.REFUND_IN_PROGRESS,
            },
          });
          if (updated.count === 0) {
            return false;
          }

          await tx.customOrderTimelineEvent.create({
            data: {
              customOrderId: order.id,
              actorType: CustomOrderActorType.SYSTEM,
              eventType: 'REFUND_INITIATED',
              payloadJson: {
                reason: 'BRAND_ACCEPTANCE_TIMEOUT',
                autoEscalated: true,
              } as Prisma.InputJsonValue,
            },
          });

          await this.refundService.initiateRefund(tx, {
            customOrderId: order.id,
            reason: 'BRAND_ACCEPTANCE_TIMEOUT',
            actorType: CustomOrderActorType.SYSTEM,
          });

          return true;
        });
        if (!escalated) {
          continue;
        }

        await this.sideEffects.enqueueNotification({
          customOrderId: order.id,
          recipientIds: [order.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
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
            notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
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
    } catch (error) {
      this.logger.warn(`Acceptance timeout cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async remindAcceptanceWindowDeadline(): Promise<void> {
    const now = new Date();
    const reminderThreshold = new Date(
      now.getTime() + ACCEPTANCE_WINDOW_REMINDER_HOURS * 60 * 60 * 1000,
    );

    try {
      const orders = await this.prisma.customOrder.findMany({
        where: {
          status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
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
        const hoursRemaining = Math.max(
          1,
          Math.ceil(
            (order.buyerAcceptanceWindowEndsAt!.getTime() - now.getTime()) /
            (60 * 60 * 1000),
          ),
        );

        await this.sideEffects.enqueueNotification({
          customOrderId: order.id,
          recipientIds: [order.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER,
          target: this.customOrderTarget(order.id),
          payload: { customOrderId: order.id, hoursRemaining },
          dedupeMs: 10 * 60 * 60 * 1000,
        });
      }

      if (orders.length > 0) {
        this.logger.log(`Queued ${orders.length} custom order acceptance reminder(s)`);
      }
    } catch (error) {
      this.logger.warn(`Acceptance reminder cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async autoCompleteExpiredAcceptanceWindows(): Promise<void> {
    const now = new Date();

    try {
      const orders = await this.prisma.customOrder.findMany({
        where: {
          status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
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
              status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
            },
            data: {
              status: CustomOrderStatus.COMPLETED,
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
              actorType: CustomOrderActorType.SYSTEM,
              eventType: 'BUYER_CONFIRMED_DELIVERY',
              payloadJson: { autoCompleted: true } as Prisma.InputJsonValue,
            },
          });

          await tx.customOrderLedgerAllocation.updateMany({
            where: {
              customOrderId: order.id,
              allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
              status: CustomOrderLedgerAllocationStatus.HELD,
            },
            data: {
              status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
              eligibleAt: now,
            },
          });
        });

        await this.sideEffects.enqueueNotification({
          customOrderId: order.id,
          recipientIds: [order.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
          target: this.customOrderTarget(order.id),
          payload: {
            customOrderId: order.id,
            status: CustomOrderStatus.COMPLETED,
            autoCompleted: true,
          },
          dedupeMs: 60 * 1000,
        });

        await this.notifyBrandOwner(order.brandId, order.id, {
          notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
          target: this.adminCustomOrderTarget(order.id),
          payload: {
            customOrderId: order.id,
            status: CustomOrderStatus.COMPLETED,
            autoCompleted: true,
          },
          dedupeMs: 60 * 1000,
        });
      }

      if (orders.length > 0) {
        this.logger.log(`Auto-completed ${orders.length} delivered custom order(s)`);
      }
    } catch (error) {
      this.logger.warn(`Acceptance window completion cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async warnOnStaleProgressStages(): Promise<void> {
    const now = new Date();

    try {
      const events = await this.prisma.customOrderProgressEvent.findMany({
        where: {
          staleThresholdAt: { lte: now },
          staleBuyerWarnedAt: null,
          customOrder: {
            status: {
              in: [
                CustomOrderStatus.ACCEPTED,
                CustomOrderStatus.IN_PRODUCTION,
                CustomOrderStatus.READY_FOR_DISPATCH,
                CustomOrderStatus.IN_TRANSIT,
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
          notificationType: NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
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
    } catch (error) {
      this.logger.warn(`Stale stage warning cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async escalatePersistentlyStaleStages(): Promise<void> {
    const now = new Date();
    const escalationThreshold = new Date(
      now.getTime() - STALE_STAGE_ESCALATION_HOURS * 60 * 60 * 1000,
    );

    try {
      const admins = await this.getActiveAdminIds();
      const events = await this.prisma.customOrderProgressEvent.findMany({
        where: {
          staleBuyerWarnedAt: { lte: escalationThreshold },
          adminEscalatedAt: null,
          customOrder: {
            status: {
              in: [
                CustomOrderStatus.ACCEPTED,
                CustomOrderStatus.IN_PRODUCTION,
                CustomOrderStatus.READY_FOR_DISPATCH,
                CustomOrderStatus.IN_TRANSIT,
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
              actorType: CustomOrderActorType.SYSTEM,
              eventType: 'ADMIN_ESCALATED',
              payloadJson: {
                reason: 'STALE_STAGE',
                stage: event.stage,
              } as Prisma.InputJsonValue,
            },
          });
        });

        await this.sideEffects.enqueueNotification({
          customOrderId: event.customOrder.id,
          recipientIds: [event.customOrder.buyerId],
          notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
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
            notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
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
    } catch (error) {
      this.logger.warn(`Stale stage escalation cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredCheckoutIntents(): Promise<void> {
    try {
      const now = new Date();
      const abandoned = await this.prisma.customOrderCheckoutSession.updateMany({
        where: {
          status: { in: [CustomOrderCheckoutStatus.SUBMITTED, CustomOrderCheckoutStatus.PAYMENT_INITIATED] },
          checkoutIntent: {
            consumedAt: null,
            expiresAt: { lt: now },
          },
        },
        data: {
          status: CustomOrderCheckoutStatus.ABANDONED,
          abandonedAt: now,
        },
      });

      const retentionDays = Math.max(
        7,
        parseInt(process.env.CUSTOM_ORDER_CHECKOUT_SESSION_RETENTION_DAYS || '', 10) || 14,
      );
      const abandonedCutoff = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      );
      const cleanedSessions = await this.prisma.customOrderCheckoutSession.deleteMany({
        where: {
          status: CustomOrderCheckoutStatus.ABANDONED,
          abandonedAt: { lt: abandonedCutoff },
          customOrderId: null,
        },
      });

      const result = await this.prisma.customOrderCheckoutIntent.deleteMany({
        where: {
          consumedAt: null,
          expiresAt: { lt: now },
          checkoutSession: { is: null },
        },
      });

      if (abandoned.count > 0) {
        this.logger.log(`Marked ${abandoned.count} custom order checkout session(s) as abandoned`);
      }
      if (cleanedSessions.count > 0) {
        this.logger.log(`Deleted ${cleanedSessions.count} abandoned custom order checkout session(s)`);
      }
      if (result.count > 0) {
        this.logger.log(`Deleted ${result.count} expired custom order checkout intent(s)`);
      }
    } catch (error) {
      this.logger.warn(`Checkout intent cleanup cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async anonymizeExpiredMeasurements(): Promise<void> {
    const now = new Date();

    try {
      const result = await this.prisma.customOrder.updateMany({
        where: {
          anonymizedAt: null,
          measurementRetentionUntil: { lt: now },
          status: {
            in: [
              CustomOrderStatus.COMPLETED,
              CustomOrderStatus.CLOSED,
              CustomOrderStatus.REJECTED_BY_BRAND,
              CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
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
    } catch (error) {
      this.logger.warn(`Measurement anonymization cron failed: ${this.formatError(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async queueEligibleCustomOrderPayouts(): Promise<void> {
    try {
      const now = new Date();
      const allocations = await this.prisma.customOrderLedgerAllocation.findMany({
        where: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
          payoutId: null,
          customOrder: {
            status: {
              in: [CustomOrderStatus.ACCEPTED, CustomOrderStatus.COMPLETED, CustomOrderStatus.CLOSED],
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
          notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
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
            actorType: CustomOrderActorType.SYSTEM,
            eventType: 'ADMIN_ESCALATED',
            payloadJson: {
              reason: 'PAYOUT_RELEASE_ELIGIBLE',
              requiresManualRelease: true,
            } as Prisma.InputJsonValue,
          },
        });
      }

      if (orderIds.length > 0) {
        this.logger.log(
          `Queued ${orderIds.length} custom-order manual payout release alert(s) for admin action`,
        );
      }
    } catch (error) {
      this.logger.warn(`Custom-order payout queue cron failed: ${this.formatError(error)}`);
    }
  }

  private customOrderTarget(customOrderId: string) {
    return {
      type: 'SYSTEM' as const,
      id: `custom-order:${customOrderId}`,
      preview: `/custom-orders/${customOrderId}`,
    };
  }

  private adminCustomOrderTarget(customOrderId: string) {
    return {
      type: 'SYSTEM' as const,
      id: `admin-custom-order:${customOrderId}`,
      preview: `/admin/custom-orders/${customOrderId}`,
    };
  }

  private studioCustomOrderTarget(customOrderId: string) {
    return {
      type: 'SYSTEM' as const,
      id: `studio-custom-order:${customOrderId}`,
      preview: `/studio/custom-orders/${customOrderId}`,
    };
  }

  private async notifyBrandOwner(
    brandId: string,
    customOrderId: string,
    options: {
      notificationType: NotificationType;
      payload: Record<string, unknown>;
      target: ReturnType<CustomOrderOpsCronService['customOrderTarget']>;
      dedupeMs?: number;
    },
  ): Promise<void> {
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

  private async getActiveAdminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.Admin, Role.SuperAdmin] },
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
      take: 50,
    });

    return admins.map((admin) => admin.id);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
