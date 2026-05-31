import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { redactSensitiveLogValue } from 'src/common/utils/sensitive-log';
import { PrismaService } from 'src/prisma/prisma.service';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'IGNORED';

export interface AdminAlertListQuery {
  cursor?: string;
  limit?: number;
  category?: string;
  severity?: string;
  status?: string;
  from?: string;
  to?: string;
  search?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
}

const ALERT_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED']);
const ALERT_SEVERITIES = new Set(['INFO', 'WARNING', 'ERROR', 'CRITICAL']);
const ALERT_CATEGORIES = new Set([
  'AUTH',
  'PAYMENT',
  'WEBHOOK',
  'UPLOAD',
  'ADMIN',
  'RANKING',
  'QUEUE',
  'MIGRATION',
  'SECURITY',
  'SYSTEM',
]);

@Injectable()
export class AdminAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminAlertListQuery) {
    const take = this.parseLimit(query.limit);
    const where = this.buildWhere(query);
    const items = await (this.prisma as any).operationalAlert.findMany({
      where,
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const rows = hasMore ? items.slice(0, take) : items;
    return {
      items: rows.map((row: any) => this.serialize(row)),
      nextCursor: hasMore ? rows[rows.length - 1]?.id : null,
    };
  }

  async summary() {
    const [open, acknowledged, resolved, ignored, critical, paymentWebhook, ranking, uploadSecurity] =
      await Promise.all([
        this.count({ status: 'OPEN' }),
        this.count({ status: 'ACKNOWLEDGED' }),
        this.count({ status: 'RESOLVED' }),
        this.count({ status: 'IGNORED' }),
        this.count({ severity: 'CRITICAL', status: { in: ['OPEN', 'ACKNOWLEDGED'] } }),
        this.count({
          category: { in: ['PAYMENT', 'WEBHOOK'] },
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        }),
        this.count({
          category: 'RANKING',
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        }),
        this.count({
          category: { in: ['UPLOAD', 'SECURITY'] },
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        }),
      ]);

    return {
      open,
      acknowledged,
      resolved,
      ignored,
      critical,
      paymentWebhook,
      ranking,
      uploadSecurity,
    };
  }

  async getById(id: string) {
    const alert = await (this.prisma as any).operationalAlert.findUnique({
      where: { id },
    });
    if (!alert) {
      throw new NotFoundException('Operational alert not found');
    }
    return this.serialize(alert);
  }

  acknowledge(id: string, actorId: string) {
    return this.updateLifecycle(id, 'ACKNOWLEDGED', {
      acknowledgedAt: new Date(),
      acknowledgedBy: actorId,
    });
  }

  resolve(id: string, actorId: string) {
    return this.updateLifecycle(id, 'RESOLVED', {
      resolvedAt: new Date(),
      resolvedBy: actorId,
    });
  }

  ignore(id: string, actorId: string) {
    return this.updateLifecycle(id, 'IGNORED', {
      ignoredAt: new Date(),
      ignoredBy: actorId,
    });
  }

  private async updateLifecycle(
    id: string,
    status: AlertStatus,
    data: Record<string, unknown>,
  ) {
    try {
      const alert = await (this.prisma as any).operationalAlert.update({
        where: { id },
        data: {
          status,
          ...data,
        },
      });
      return this.serialize(alert);
    } catch (error: any) {
      if (error?.code === 'P2025') {
        throw new NotFoundException('Operational alert not found');
      }
      throw error;
    }
  }

  private async count(where: Record<string, unknown>) {
    return (this.prisma as any).operationalAlert.count({ where });
  }

  private buildWhere(query: AdminAlertListQuery): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    const category = this.normalizeEnum(query.category, ALERT_CATEGORIES, 'category');
    const severity = this.normalizeEnum(query.severity, ALERT_SEVERITIES, 'severity');
    const status = this.normalizeEnum(query.status, ALERT_STATUSES, 'status');

    if (category) where.category = category;
    if (severity) where.severity = severity;
    if (status) where.status = status;
    if (query.entityType) where.entityType = String(query.entityType).trim();
    if (query.entityId) where.entityId = String(query.entityId).trim();
    if (query.correlationId) where.correlationId = String(query.correlationId).trim();

    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from || to) {
      where.lastSeenAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }

    const search = String(query.search ?? '').trim();
    if (search) {
      where.OR = [
        { event: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        { correlationId: { contains: search, mode: 'insensitive' } },
        { entityId: { contains: search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private parseLimit(limit?: number): number {
    const parsed = Number(limit ?? 50);
    if (!Number.isFinite(parsed) || parsed <= 0) return 50;
    return Math.min(Math.floor(parsed), 100);
  }

  private normalizeEnum(
    value: string | undefined,
    allowed: Set<string>,
    label: string,
  ): string | undefined {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (!normalized || normalized === 'ALL') return undefined;
    if (!allowed.has(normalized)) {
      throw new BadRequestException(`Unsupported alert ${label}`);
    }
    return normalized;
  }

  private parseDate(value: string | undefined, label: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid alert ${label} date`);
    }
    return parsed;
  }

  private serialize(row: any) {
    return {
      id: row.id,
      category: row.category,
      severity: row.severity,
      event: row.event,
      title: row.title,
      message: row.message,
      status: row.status,
      actorId: row.actorId,
      userId: row.userId,
      entityType: row.entityType,
      entityId: row.entityId,
      correlationId: row.correlationId,
      metadata: redactSensitiveLogValue(row.metadata ?? {}) as Prisma.JsonValue,
      dedupeKey: row.dedupeKey,
      occurrenceCount: row.occurrenceCount,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      acknowledgedAt: row.acknowledgedAt,
      acknowledgedBy: row.acknowledgedBy,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
      ignoredAt: row.ignoredAt,
      ignoredBy: row.ignoredBy,
      notificationQueuedAt: row.notificationQueuedAt,
      emailQueuedAt: row.emailQueuedAt,
    };
  }
}
