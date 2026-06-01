import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailPriority, NotificationType } from '@prisma/client';
import { createHash } from 'crypto';
import { EmailService } from 'src/email/email.service';
import { redactSensitiveLogValue } from 'src/common/utils/sensitive-log';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertCategory,
  OperationalAlert,
  SanitizedOperationalAlert,
} from './monitoring.types';

const MAX_BUFFERED_ALERTS = 200;
const ALERT_EMAIL_SCENARIO_KEY = 'operational.alert.critical';

const ADMIN_NOTIFICATION_EVENTS = new Set([
  'PAYMENT_WEBHOOK_INVALID_SIGNATURE',
  'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
  'PAYMENT_WEBHOOK_UNKNOWN_REFERENCE',
  'UNIFIED_FINALIZATION_COMPENSATION_REQUIRED',
  'upload_finalize_owner_mismatch',
  'upload_finalize_key_prefix_mismatch',
  'break_glass_failure',
  'break_glass_success',
  'market_signal_duplicate_preflight_failed',
  'market_signal_duplicate_batch_replay',
  'market_signal_batch_oversized',
  'market_ranking_aggregation_failed',
  'market_ranking_aggregate_read_failed',
  'content_report_high_severity',
]);

type PersistedAlertRow = {
  id: string;
  category: string;
  severity: string;
  event: string;
  title?: string | null;
  message: string;
  status: string;
  actorId?: string | null;
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  occurrenceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
};

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly bufferedAlerts: SanitizedOperationalAlert[] = [];
  private readonly pendingPersistence = new Set<Promise<void>>();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly emailService?: EmailService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  emitAlert(alert: OperationalAlert): SanitizedOperationalAlert {
    const sanitized = this.sanitizeAlert(alert);
    this.bufferAlert(sanitized);
    this.writeLocalLog(sanitized);
    this.persistAlertInBackground(sanitized);
    return sanitized;
  }

  emitAuditAlert(
    alert: Omit<OperationalAlert, 'category'> & {
      category?: AlertCategory;
    },
  ): SanitizedOperationalAlert {
    return this.emitAlert({
      ...alert,
      category: alert.category ?? 'ADMIN',
    });
  }

  emitMetric(
    event: string,
    metadata: Record<string, unknown> = {},
    category: AlertCategory = 'SYSTEM',
  ): SanitizedOperationalAlert {
    return this.emitAlert({
      category,
      severity: 'info',
      event,
      message: event,
      metadata,
    });
  }

  getBufferedAlerts(): SanitizedOperationalAlert[] {
    return [...this.bufferedAlerts];
  }

  clearBufferedAlerts(): void {
    this.bufferedAlerts.splice(0, this.bufferedAlerts.length);
  }

  async flushPendingPersistenceForTests(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingPersistence));
  }

  private sanitizeAlert(alert: OperationalAlert): SanitizedOperationalAlert {
    const metadata = redactSensitiveLogValue(alert.metadata ?? {}) as Record<
      string,
      unknown
    >;
    return {
      category: alert.category,
      severity: alert.severity,
      event: alert.event,
      title: alert.title ?? this.humanizeEvent(alert.event),
      message: String(alert.message || alert.event),
      correlationId: alert.correlationId ?? undefined,
      userId: alert.userId ?? undefined,
      actorId: alert.actorId ?? undefined,
      entityType: alert.entityType ?? undefined,
      entityId: alert.entityId ?? undefined,
      dedupeKey: alert.dedupeKey ?? undefined,
      metadata,
      emittedAt: new Date().toISOString(),
    };
  }

  private persistAlertInBackground(alert: SanitizedOperationalAlert): void {
    if (!this.prisma) return;

    const persistence = this.persistAlert(alert)
      .then(() => undefined)
      .catch((error) => {
        this.logger.warn(
          `Operational alert persistence failed event=${alert.event}: ${error?.message ?? error}`,
        );
      })
      .finally(() => {
        this.pendingPersistence.delete(persistence);
      });

    this.pendingPersistence.add(persistence);
  }

  private async persistAlert(
    alert: SanitizedOperationalAlert,
  ): Promise<PersistedAlertRow | null> {
    const operationalAlert = (this.prisma as any).operationalAlert;
    if (!operationalAlert?.upsert || !operationalAlert?.create) {
      return null;
    }

    const now = new Date();
    const firstSeenAt = this.safeDate(alert.emittedAt, now);
    const dedupeKey = alert.dedupeKey ?? this.buildDedupeKey(alert);
    const payload = {
      id: uuidv4(),
      category: alert.category,
      severity: alert.severity.toUpperCase(),
      event: alert.event,
      title: alert.title ?? this.humanizeEvent(alert.event),
      message: alert.message,
      status: 'OPEN',
      actorId: alert.actorId ?? null,
      userId: alert.userId ?? null,
      entityType: alert.entityType ?? null,
      entityId: alert.entityId ?? null,
      correlationId: alert.correlationId ?? null,
      metadata: alert.metadata ?? {},
      dedupeKey,
      occurrenceCount: 1,
      firstSeenAt,
      lastSeenAt: now,
    };

    const persisted = dedupeKey
      ? await operationalAlert.upsert({
          where: { dedupeKey },
          create: payload,
          update: {
            category: payload.category,
            severity: payload.severity,
            message: payload.message,
            metadata: payload.metadata,
            status: 'OPEN',
            resolvedAt: null,
            resolvedBy: null,
            ignoredAt: null,
            ignoredBy: null,
            lastSeenAt: now,
            occurrenceCount: { increment: 1 },
          },
        })
      : await operationalAlert.create({ data: payload });

    if (persisted?.occurrenceCount === 1) {
      await this.routeAlert(persisted);
    }

    return persisted;
  }

  private async routeAlert(alert: PersistedAlertRow): Promise<void> {
    if (!this.shouldNotifyAdmins(alert) && !this.shouldEmail(alert)) return;

    const recipients = await this.resolveAdminAlertRecipients();
    if (recipients.length === 0) return;

    if (this.shouldNotifyAdmins(alert) && this.notificationsService) {
      await Promise.allSettled(
        recipients
          .filter((recipient) => recipient.userId)
          .map((recipient) =>
            this.notificationsService!.create(
              recipient.userId!,
              NotificationType.ADMIN_ACTION,
              {
                payload: this.buildNotificationPayload(alert),
                target: {
                  type: 'SYSTEM',
                  id: alert.id,
                  preview: alert.title ?? alert.event,
                },
                dedupeMs: 10 * 60 * 1000,
                suppressEmail: true,
                suppressPush: true,
              },
            ),
          ),
      );

      await (this.prisma as any).operationalAlert.update({
        where: { id: alert.id },
        data: { notificationQueuedAt: new Date() },
      });
    }

    if (this.shouldEmail(alert) && this.emailService) {
      await Promise.allSettled(
        recipients
          .filter((recipient) => recipient.email)
          .map((recipient) =>
            this.emailService!.send(
              recipient.email!,
              `[Threadly] ${alert.severity} ${alert.category} alert`,
              this.renderAlertEmailHtml(alert),
              this.renderAlertEmailText(alert),
              {
                recipientUserId: recipient.userId ?? null,
                scenarioKey: ALERT_EMAIL_SCENARIO_KEY,
                notificationType: NotificationType.ADMIN_ACTION,
                priority: EmailPriority.P0_SECURITY,
                idempotencyKey: `operational-alert:${alert.id}:${this.hashValue(
                  recipient.email!,
                )}`,
              },
            ),
          ),
      );

      await (this.prisma as any).operationalAlert.update({
        where: { id: alert.id },
        data: { emailQueuedAt: new Date() },
      });
    }
  }

  private async resolveAdminAlertRecipients(): Promise<
    Array<{ userId?: string | null; email?: string | null }>
  > {
    const recipients = new Map<
      string,
      { userId?: string | null; email?: string | null }
    >();

    const configuredEmails = this.parseConfiguredAlertEmails();
    configuredEmails.forEach((email) => {
      recipients.set(`email:${email.toLowerCase()}`, { email });
    });

    const userModel = (this.prisma as any)?.user;
    if (!userModel?.findMany) return Array.from(recipients.values());

    const admins = await userModel.findMany({
      where: {
        OR: [
          { role: 'SuperAdmin' },
          {
            role: 'Admin',
            adminPermissionGrants: {
              some: { permissionCode: 'alerts.read' },
            },
          },
        ],
      },
      select: { id: true, email: true },
      take: 50,
    });

    for (const admin of admins ?? []) {
      if (!admin?.id) continue;
      recipients.set(`user:${admin.id}`, {
        userId: admin.id,
        email: typeof admin.email === 'string' ? admin.email : null,
      });
    }

    return Array.from(recipients.values());
  }

  private buildNotificationPayload(alert: PersistedAlertRow) {
    return {
      action: 'OPERATIONAL_ALERT',
      message: alert.title ?? alert.message,
      targetUrl: `/admin/monitoring?alertId=${encodeURIComponent(alert.id)}`,
      operationalAlertId: alert.id,
      alertSeverity: alert.severity,
      alertCategory: alert.category,
      alertEvent: alert.event,
      alertStatus: alert.status,
      correlationId: alert.correlationId ?? undefined,
      entityType: alert.entityType ?? undefined,
      entityId: alert.entityId ?? undefined,
    };
  }

  private renderAlertEmailHtml(alert: PersistedAlertRow): string {
    const lines = [
      ['Severity', alert.severity],
      ['Category', alert.category],
      ['Event', alert.event],
      ['Message', alert.message],
      ['Timestamp', alert.firstSeenAt.toISOString()],
      ['Correlation ID', alert.correlationId ?? 'n/a'],
      ['Entity', this.formatEntity(alert)],
      ['Admin Path', `/admin/monitoring?alertId=${alert.id}`],
    ];

    return [
      '<h1>Threadly operational alert</h1>',
      '<table>',
      ...lines.map(
        ([label, value]) =>
          `<tr><th align="left">${this.escapeHtml(label)}</th><td>${this.escapeHtml(value)}</td></tr>`,
      ),
      '</table>',
    ].join('');
  }

  private renderAlertEmailText(alert: PersistedAlertRow): string {
    return [
      'Threadly operational alert',
      `Severity: ${alert.severity}`,
      `Category: ${alert.category}`,
      `Event: ${alert.event}`,
      `Message: ${alert.message}`,
      `Timestamp: ${alert.firstSeenAt.toISOString()}`,
      `Correlation ID: ${alert.correlationId ?? 'n/a'}`,
      `Entity: ${this.formatEntity(alert)}`,
      `Admin Path: /admin/monitoring?alertId=${alert.id}`,
    ].join('\n');
  }

  private parseConfiguredAlertEmails(): string[] {
    const raw =
      this.config?.get<string>('ALERT_EMAIL_RECIPIENTS') ??
      this.config?.get<string>('OPERATIONAL_ALERT_EMAIL_RECIPIENTS') ??
      '';
    return raw
      .split(',')
      .map((email) => email.trim())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  }

  private shouldNotifyAdmins(alert: PersistedAlertRow): boolean {
    return (
      alert.severity === 'CRITICAL' ||
      ADMIN_NOTIFICATION_EVENTS.has(alert.event)
    );
  }

  private shouldEmail(alert: PersistedAlertRow): boolean {
    return alert.severity === 'CRITICAL';
  }

  private buildDedupeKey(alert: SanitizedOperationalAlert): string {
    return this.hashValue(
      JSON.stringify([
        alert.category,
        alert.severity,
        alert.event,
        alert.correlationId ?? '',
        alert.entityType ?? '',
        alert.entityId ?? '',
      ]),
    );
  }

  private hashValue(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private safeDate(value: string, fallback: Date): Date {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  private formatEntity(alert: PersistedAlertRow): string {
    if (!alert.entityType && !alert.entityId) return 'n/a';
    return `${alert.entityType ?? 'entity'}:${alert.entityId ?? 'unknown'}`;
  }

  private humanizeEvent(event: string): string {
    return event
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/^\w/, (char) => char.toUpperCase());
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private bufferAlert(alert: SanitizedOperationalAlert): void {
    this.bufferedAlerts.push(alert);
    if (this.bufferedAlerts.length > MAX_BUFFERED_ALERTS) {
      this.bufferedAlerts.shift();
    }
  }

  private writeLocalLog(alert: SanitizedOperationalAlert): void {
    const payload = JSON.stringify({
      category: alert.category,
      event: alert.event,
      correlationId: alert.correlationId,
      userId: alert.userId,
      actorId: alert.actorId,
      entityType: alert.entityType,
      entityId: alert.entityId,
      metadata: alert.metadata,
    });

    const line = `${alert.category}.${alert.event}: ${alert.message} ${payload}`;
    switch (alert.severity) {
      case 'critical':
      case 'error':
        this.logger.error(line);
        break;
      case 'warning':
        this.logger.warn(line);
        break;
      default:
        this.logger.log(line);
        break;
    }
  }
}
