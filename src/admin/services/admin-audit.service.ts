import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

export interface AuditLogEntry {
  actorUserId: string;
  action: AdminAuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
}

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  private sanitizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey.includes('password') ||
          normalizedKey.includes('token') ||
          normalizedKey.includes('secret') ||
          normalizedKey.includes('otp') ||
          normalizedKey.includes('card')
        ) {
          return [key, '[redacted]'];
        }

        return [key, this.sanitizeValue(item)];
      }),
    );
  }

  private toJson(value?: Record<string, unknown>) {
    if (value === undefined) {
      return Prisma.JsonNull;
    }
    return this.sanitizeValue(value) as Prisma.InputJsonValue;
  }

  /**
   * Write an immutable audit log entry.
   * Designed to be called within a Prisma transaction or standalone.
   */
  async log(entry: AuditLogEntry, req?: Request) {
    await this.prisma.adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: this.toJson(entry.metadata),
        previousState: this.toJson(entry.previousState),
        newState: this.toJson(entry.newState),
        ipAddress: req ? this.extractIp(req) : null,
        userAgent: req?.headers['user-agent'] ?? null,
      },
    });
  }

  async safeLog(entry: AuditLogEntry, req?: Request) {
    try {
      await this.log(entry, req);
    } catch (error: any) {
      this.logger.warn(
        `Audit log write failed for action=${entry.action} target=${entry.targetType ?? 'unknown'}:${entry.targetId ?? 'unknown'}: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Write audit log inside a Prisma transaction.
   */
  async logInTransaction(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    entry: AuditLogEntry,
    req?: Request,
  ) {
    await (tx as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: this.toJson(entry.metadata),
        previousState: this.toJson(entry.previousState),
        newState: this.toJson(entry.newState),
        ipAddress: req ? this.extractIp(req) : null,
        userAgent: req?.headers['user-agent'] ?? null,
      },
    });
  }

  async safeLogInTransaction(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    entry: AuditLogEntry,
    req?: Request,
  ) {
    try {
      await this.logInTransaction(tx, entry, req);
    } catch (error: any) {
      this.logger.warn(
        `Transactional audit log write failed for action=${entry.action} target=${entry.targetType ?? 'unknown'}:${entry.targetId ?? 'unknown'}: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Paginated audit log retrieval.
   */
  async findMany(params: {
    cursor?: string;
    limit?: number;
    actorUserId?: string;
    action?: AdminAuditAction;
    targetType?: string;
    targetId?: string;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.actorUserId) where.actorUserId = params.actorUserId;
    if (params.action) where.action = params.action;
    if (params.targetType) where.targetType = params.targetType;
    if (params.targetId) where.targetId = params.targetId;

    const items = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return { items: results, nextCursor };
  }

  private extractIp(req: Request): string | null {
    return req.socket?.remoteAddress ?? null;
  }
}
