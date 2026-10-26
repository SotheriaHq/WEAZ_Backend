import type { NotificationEvent } from '../notifications/notification-batch-query';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, PhysicalVerificationStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Nobody should have to remember the appointment themselves.
 *
 * The slot is already stored the moment a brand accepts one, so the system
 * knows when the visit is and who is expected. Three things follow from that,
 * and all three used to be somebody's job to remember:
 *
 *  - remind BOTH sides before a confirmed visit;
 *  - nudge whoever owes a reply when they have not given one;
 *  - say something when the slot came and went with no outcome recorded.
 *
 * Every job is idempotent through an "already sent" column rather than by
 * recomputing from timestamps, because this runs every quarter hour and a
 * reminder that re-sends until the appointment arrives is worse than none.
 */

/** Ahead of the visit. Two marks, so a day's notice and an hour's both land. */
const DAY_BEFORE_MS = 24 * 60 * 60 * 1000;
const HOUR_BEFORE_MS = 60 * 60 * 1000;
/** How long a side may sit on a reply before being nudged, and how often after. */
const BRAND_REPLY_GRACE_MS = 24 * 60 * 60 * 1000;
const AGENT_REPLY_GRACE_MS = 12 * 60 * 60 * 1000;
const RENUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A visit is only "overdue" once the window has genuinely passed. */
const OVERDUE_GRACE_MS = 3 * 60 * 60 * 1000;
const BATCH = 200;

@Injectable()
export class PhysicalVerificationCronService {
  private readonly logger = new Logger(PhysicalVerificationCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async runVisitReminders(): Promise<void> {
    await this.remindBeforeVisit();
    await this.nudgeAwaitingReply();
    await this.flagOverdueVisits();
  }

  /**
   * A day out, then an hour out, to the brand AND the agent.
   *
   * Both sides, because a visit nobody turns up to wastes the same day whether
   * it was the brand or the agent who forgot.
   */
  private async remindBeforeVisit(): Promise<void> {
    const now = new Date();

    for (const window of [
      {
        ms: DAY_BEFORE_MS,
        field: 'reminderDayBeforeAt' as const,
        label: 'tomorrow',
      },
      {
        ms: HOUR_BEFORE_MS,
        field: 'reminderHourBeforeAt' as const,
        label: 'in about an hour',
      },
    ]) {
      const rows = await this.prisma.brandPhysicalVerification.findMany({
        where: {
          status: PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
          selectedSlotAt: {
            gt: now,
            lte: new Date(now.getTime() + window.ms),
          },
          [window.field]: null,
        },
        take: BATCH,
        include: { brand: { select: { id: true, name: true, ownerId: true } } },
      });

      const events: NotificationEvent[] = [];
      for (const row of rows) {
        const payload = {
          physicalVerificationId: row.id,
          brandId: row.brandId,
          brandName: row.brand.name,
          scheduledFor: row.selectedSlotAt?.toISOString() ?? null,
          when: window.label,
        };
        events.push({
          recipientId: row.brand.ownerId,
          type: NotificationType.VERIFICATION_VISIT_REMINDER,
          opts: { payload: { ...payload, targetUrl: '/studio/verification' } },
        });
        if (row.assignedAgentId)
          events.push({
            recipientId: row.assignedAgentId,
            type: NotificationType.VERIFICATION_VISIT_REMINDER,
            opts: {
              payload: {
                ...payload,
                targetUrl: `/admin/verification/visits/${row.id}`,
              },
            },
          });
      }
      await this.sendEvents(events);
      // Keep the existing once-per-window marker behavior, including failed recipients.
      if (rows.length)
        await this.prisma.brandPhysicalVerification.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { [window.field]: now },
        });
    }
  }

  /** Whoever owes a reply hears about it — once, then daily. */
  private async nudgeAwaitingReply(): Promise<void> {
    const now = new Date();
    const renudgeBefore = new Date(now.getTime() - RENUDGE_INTERVAL_MS);

    // The brand owes an answer to a proposal.
    const awaitingBrand = await this.prisma.brandPhysicalVerification.findMany({
      where: {
        status: PhysicalVerificationStatus.SCHEDULE_PROPOSED,
        scheduleProposedAt: {
          lte: new Date(now.getTime() - BRAND_REPLY_GRACE_MS),
        },
        OR: [
          { awaitingReplyNudgedAt: null },
          { awaitingReplyNudgedAt: { lte: renudgeBefore } },
        ],
      },
      take: BATCH,
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    await this.sendEvents(
      awaitingBrand.map((row) => ({
        recipientId: row.brand.ownerId,
        type: NotificationType.VERIFICATION_VISIT_RESPONSE_DUE,
        opts: {
          payload: {
            physicalVerificationId: row.id,
            brandId: row.brandId,
            owes: 'BRAND',
            targetUrl: '/studio/verification',
          },
        },
      })),
    );
    if (awaitingBrand.length)
      await this.prisma.brandPhysicalVerification.updateMany({
        where: { id: { in: awaitingBrand.map((row) => row.id) } },
        data: { awaitingReplyNudgedAt: now },
      });

    // The agent owes an answer to a reschedule request.
    const awaitingAgent = await this.prisma.brandPhysicalVerification.findMany({
      where: {
        status: PhysicalVerificationStatus.RESCHEDULE_REQUESTED,
        brandRespondedAt: {
          lte: new Date(now.getTime() - AGENT_REPLY_GRACE_MS),
        },
        assignedAgentId: { not: null },
        OR: [
          { awaitingReplyNudgedAt: null },
          { awaitingReplyNudgedAt: { lte: renudgeBefore } },
        ],
      },
      take: BATCH,
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    const assigned = awaitingAgent.filter((row) => row.assignedAgentId);
    await this.sendEvents(
      assigned.map((row) => ({
        recipientId: row.assignedAgentId!,
        type: NotificationType.VERIFICATION_VISIT_RESPONSE_DUE,
        opts: {
          payload: {
            physicalVerificationId: row.id,
            brandId: row.brandId,
            brandName: row.brand.name,
            owes: 'AGENT',
            targetUrl: `/admin/verification/visits/${row.id}`,
          },
        },
      })),
    );
    if (assigned.length)
      await this.prisma.brandPhysicalVerification.updateMany({
        where: { id: { in: assigned.map((row) => row.id) } },
        data: { awaitingReplyNudgedAt: now },
      });
  }

  /**
   * The slot passed and no outcome was recorded.
   *
   * Without this a confirmed visit that simply did not happen sits in
   * SCHEDULE_CONFIRMED forever, looking like an appointment still to come, and
   * the brand waits on a badge nobody is coming to grant.
   */
  private async flagOverdueVisits(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.brandPhysicalVerification.findMany({
      where: {
        status: PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
        selectedSlotAt: { lte: new Date(now.getTime() - OVERDUE_GRACE_MS) },
        overdueNudgedAt: null,
      },
      take: BATCH,
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    await this.sendEvents(
      rows
        .filter((row) => row.assignedAgentId)
        .map((row) => ({
          recipientId: row.assignedAgentId!,
          type: NotificationType.VERIFICATION_VISIT_OVERDUE,
          opts: {
            payload: {
              physicalVerificationId: row.id,
              brandId: row.brandId,
              brandName: row.brand.name,
              scheduledFor: row.selectedSlotAt?.toISOString() ?? null,
              targetUrl: `/admin/verification/visits/${row.id}`,
            },
          },
        })),
    );
    if (rows.length)
      await this.prisma.brandPhysicalVerification.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { overdueNudgedAt: now },
      });
  }

  /** One bad recipient must not stop the batch. */
  private async sendEvents(events: NotificationEvent[]): Promise<void> {
    if (!events.length) return;
    const results = await this.notifications.createEvents(events);
    results.forEach((result, index) => {
      if (result.status === 'rejected')
        this.logger.warn(
          `Physical verification notification failed type=${events[index].type} user=${events[index].recipientId}: ${String(result.reason)}`,
        );
    });
  }
}
