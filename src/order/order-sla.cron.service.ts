import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  NotificationType,
  OrderStatus,
  PaymentStatus,
  Role,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  businessHoursElapsedHours,
  coerceWorkingHours,
  isCurrentlyOpen,
  isValidIanaTimeZone,
} from '../store/working-hours.util';
import { OrderRefundService } from './order-refund.service';

/**
 * Standard-order fulfilment SLA engine (Phase 1 of ORDER_LIFECYCLE_SLA_AND_SYNC).
 *
 * Mirrors the mature custom-order SLA cron, but for standard (ready-made) orders,
 * which previously had NO nudge/escalation automation. Cost-first & stateless:
 *  - no new table — SLA windows are derived from `paidAt` + config;
 *  - tier reminders fire in a NARROW [T, T+1h) window so, with the hourly cron,
 *    each tier fires exactly once (no per-order flags, no dedupe table);
 *  - brand nudges use the two non-email notification types, so they are in-app +
 *    push only (free) — no recurring email spend;
 *  - the auto-cancel path is idempotent (status-guarded `updateMany`).
 *
 * Everything is behind `ORDER_SLA_ENABLED` (default OFF) for a safe rollout, and
 * auto-cancel is behind `ORDER_SLA_AUTO_CANCEL_ENABLED` (default OFF →
 * admin-escalation-only). Thresholds are env-configurable; see §3/§6 of the plan.
 */
@Injectable()
export class OrderSlaCronService {
  private readonly logger = new Logger(OrderSlaCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly orderRefundService: OrderRefundService,
  ) {}

  private isEnabled(): boolean {
    return String(process.env.ORDER_SLA_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  }

  private isAutoCancelEnabled(): boolean {
    return (
      String(process.env.ORDER_SLA_AUTO_CANCEL_ENABLED ?? 'false')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  private envHours(key: string, fallback: number): number {
    const parsed = Number(process.env[key]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  // Brand should dispatch a paid order within this window. NOTE: once the
  // Business Hours feature lands (see plan §11), this is measured in the brand's
  // WORKING hours, not wall-clock. Default is the "shorter" profile: 1 day.
  private dispatchSlaHours(): number {
    return this.envHours('ORDER_SLA_DISPATCH_HOURS', 24);
  }

  // Past this, the order is a hard breach → admin escalation (or auto-cancel if
  // enabled). "Shorter" default: 3 days.
  private hardCloseHours(): number {
    return this.envHours('ORDER_SLA_HARD_CLOSE_HOURS', 72);
  }

  private tiers(): Array<{ key: 'GENTLE' | 'FIRM' | 'FINAL'; atHours: number }> {
    const dispatch = this.dispatchSlaHours();
    return [
      { key: 'GENTLE', atHours: dispatch * 0.5 },
      { key: 'FIRM', atHours: dispatch * 0.8 },
      { key: 'FINAL', atHours: dispatch },
    ];
  }

  private readonly UNSHIPPED_STATUSES = [
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
  ];

  // Business-hours SLAs accrue slowly (e.g. 72 business-hours ≈ ~12 calendar
  // days), so we scan a generous wall-clock window of unshipped+paid orders and
  // do the real (business-hours or wall-clock) math per order.
  private readonly LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

  // Elapsed hours toward the SLA. Business-hours mode (brand has a valid schedule
  // + timezone) only accrues during open hours; otherwise wall-clock. Reminders
  // fire only while `currentlyOpen` so a frozen-overnight elapsed can't re-fire a
  // tier on every closed-hour run.
  private computeOrderElapsed(
    order: {
      paidAt: Date | null;
      brand: { workingHours: unknown; timezone: string | null } | null;
    },
    nowMs: number,
  ): { elapsedHours: number; businessMode: boolean; currentlyOpen: boolean } {
    const paidMs = order.paidAt?.getTime() ?? nowMs;
    const wallHours = Math.max(0, (nowMs - paidMs) / (60 * 60 * 1000));
    const schedule = coerceWorkingHours(order.brand?.workingHours);
    const tz = order.brand?.timezone ?? null;
    if (schedule && tz && isValidIanaTimeZone(tz)) {
      const nowDate = new Date(nowMs);
      return {
        elapsedHours: businessHoursElapsedHours(
          new Date(paidMs),
          nowDate,
          schedule,
          tz,
        ),
        businessMode: true,
        currentlyOpen: isCurrentlyOpen(schedule, tz, nowDate),
      };
    }
    return { elapsedHours: wallHours, businessMode: false, currentlyOpen: true };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async remindBrandFulfilment(): Promise<void> {
    if (!this.isEnabled()) return;

    const now = Date.now();
    const tiers = this.tiers();
    const lookbackStart = new Date(now - this.LOOKBACK_MS);

    try {
      const orders = await this.prisma.order.findMany({
        where: {
          status: { in: this.UNSHIPPED_STATUSES },
          paymentStatus: PaymentStatus.PAID,
          paidAt: { not: null, gte: lookbackStart },
        },
        select: {
          id: true,
          status: true,
          paidAt: true,
          brand: {
            select: { ownerId: true, workingHours: true, timezone: true },
          },
        },
        orderBy: { paidAt: 'asc' },
        take: 300,
      });

      let nudged = 0;
      for (const order of orders) {
        if (!order.paidAt) continue;
        const { elapsedHours, businessMode, currentlyOpen } =
          this.computeOrderElapsed(order, now);
        // Business-hours mode: only fire while open (elapsed is moving) so a tier
        // can't re-fire across frozen closed-hour runs.
        if (businessMode && !currentlyOpen) continue;
        const tier = tiers.find(
          (t) => elapsedHours >= t.atHours && elapsedHours < t.atHours + 1,
        );
        if (!tier) continue;

        const brandOwnerId = order.brand?.ownerId;
        if (!brandOwnerId) continue;

        await this.notifications.create(
          brandOwnerId,
          NotificationType.ORDER_FULFILLMENT_REMINDER,
          {
            payload: {
              orderId: order.id,
              tier: tier.key,
              status: order.status,
              hoursElapsed: Math.floor(elapsedHours),
              // Deep-link straight to the exact order (OrderDetail resolves
              // buyer/brand/admin access + the role-appropriate actions).
              targetUrl: `/orders/${order.id}`,
            },
          },
        );
        // Immediate realtime nudge to the brand's order views (free, no worker).
        await this.notifications.emitOrderUpdated([brandOwnerId], {
          kind: 'STANDARD',
          orderId: order.id,
          status: order.status,
        });
        nudged += 1;
      }

      if (nudged > 0) {
        this.logger.log(`Sent ${nudged} standard-order fulfilment reminder(s)`);
      }
    } catch (error) {
      this.logger.warn(
        `Standard-order fulfilment reminder cron failed: ${this.formatError(error)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async escalateOrCloseOverdue(): Promise<void> {
    if (!this.isEnabled()) return;

    const now = Date.now();
    const hardCloseHours = this.hardCloseHours();
    const autoCancel = this.isAutoCancelEnabled();
    const lookbackStart = new Date(now - this.LOOKBACK_MS);

    try {
      const admins = await this.getActiveAdminIds();

      // Scan unshipped+paid orders in a generous window; the real
      // (business-hours or wall-clock) elapsed decides overdue per order.
      const orders = await this.prisma.order.findMany({
        where: {
          status: { in: this.UNSHIPPED_STATUSES },
          paymentStatus: PaymentStatus.PAID,
          paidAt: { not: null, gte: lookbackStart },
        },
        select: {
          id: true,
          buyerId: true,
          status: true,
          paidAt: true,
          brand: {
            select: { ownerId: true, workingHours: true, timezone: true },
          },
        },
        orderBy: { paidAt: 'asc' },
        take: 300,
      });

      let actioned = 0;
      for (const order of orders) {
        const { elapsedHours, businessMode, currentlyOpen } =
          this.computeOrderElapsed(order, now);
        if (elapsedHours < hardCloseHours) continue; // not a breach yet
        const brandOwnerId = order.brand?.ownerId ?? null;

        if (autoCancel) {
          let cancelled = false;
          try {
            cancelled = await this.prisma.$transaction(async (tx) => {
              const updated = await tx.order.updateMany({
                where: {
                  id: order.id,
                  status: { in: this.UNSHIPPED_STATUSES },
                },
                data: { status: OrderStatus.CANCELLED },
              });
              if (updated.count === 0) return false;
              await this.orderRefundService.initiateRefund(tx, {
                orderId: order.id,
                reason: 'SLA_FULFILLMENT_TIMEOUT',
              });
              return true;
            });
          } catch (error) {
            this.logger.warn(
              `Auto-cancel failed for order ${order.id}: ${this.formatError(error)}`,
            );
            continue;
          }
          if (!cancelled) continue;

          await this.notifyOverdue(
            order.id,
            true,
            [order.buyerId, brandOwnerId, ...admins],
          );
          await this.notifications.emitOrderUpdated(
            [order.buyerId, brandOwnerId],
            { kind: 'STANDARD', orderId: order.id, status: OrderStatus.CANCELLED },
          );
          actioned += 1;
        } else {
          // Admin-escalation-only: fire once as the order crosses hard close
          // ([hardClose, hardClose+1h)); in business mode only while open so it
          // doesn't repeat across frozen closed-hour runs.
          if (elapsedHours >= hardCloseHours + 1) continue;
          if (businessMode && !currentlyOpen) continue;
          await this.notifyOverdue(order.id, false, [brandOwnerId, ...admins]);
          actioned += 1;
        }
      }

      if (actioned > 0) {
        this.logger.log(
          `Processed ${actioned} overdue standard order(s) (autoCancel=${autoCancel})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Standard-order overdue cron failed: ${this.formatError(error)}`,
      );
    }
  }

  private async notifyOverdue(
    orderId: string,
    autoCancelled: boolean,
    recipientIds: Array<string | null | undefined>,
  ): Promise<void> {
    const uniqueIds = Array.from(
      new Set(
        recipientIds
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter((id) => id.length > 0),
      ),
    );
    for (const recipientId of uniqueIds) {
      try {
        await this.notifications.create(
          recipientId,
          NotificationType.ORDER_FULFILLMENT_OVERDUE,
          {
            payload: {
              orderId,
              autoCancelled,
              reason: 'SLA_FULFILLMENT_TIMEOUT',
              // Exact order for everyone (OrderDetail resolves per-role access).
              targetUrl: `/orders/${orderId}`,
            },
          },
        );
      } catch (error) {
        this.logger.warn(
          `Overdue notification failed for ${recipientId} on order ${orderId}: ${this.formatError(error)}`,
        );
      }
    }
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
