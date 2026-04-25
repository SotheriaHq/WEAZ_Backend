import { Injectable } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  private toJson(value?: Record<string, unknown>) {
    if (value === undefined) {
      return Prisma.JsonNull;
    }
    return value as Prisma.InputJsonValue;
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
