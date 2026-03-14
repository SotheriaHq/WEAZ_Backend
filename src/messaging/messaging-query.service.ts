import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MessageKind, MessageParticipantRole, MessageVisibilityState } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class MessagingQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async getThreadById(threadId: string) {
    return this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: {
        participants: true,
      },
    });
  }

  async getMessages(
    threadId: string,
    options?: { cursorCreatedAt?: string; cursorId?: string; limit?: number },
    filters?: { includeModerated?: boolean },
  ) {
    const take = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const cursorCreatedAt = options?.cursorCreatedAt ? new Date(options.cursorCreatedAt) : null;
    const cursorId = options?.cursorId;
    const includeModerated = filters?.includeModerated === true;

    const messages = await this.prisma.message.findMany({
      where: {
        threadId,
        ...(cursorCreatedAt && cursorId
          ? {
              OR: [
                { createdAt: { lt: cursorCreatedAt } },
                { createdAt: cursorCreatedAt, id: { lt: cursorId } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
        attachments: {
          include: {
            file: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                mimeType: true,
                size: true,
              },
            },
          },
        },
      },
    });

    const hasNextPage = messages.length > take;
    const rawItems = hasNextPage ? messages.slice(0, -1) : messages;
    const items = includeModerated
      ? rawItems
      : rawItems.map((message) => {
          if (message.visibilityState === MessageVisibilityState.VISIBLE) {
            return message;
          }

          return {
            ...message,
            senderUserId: null,
            senderRole: MessageParticipantRole.SYSTEM,
            kind: MessageKind.MODERATION_NOTICE,
            bodyText:
              message.visibilityState === MessageVisibilityState.REDACTED
                ? 'This message was removed by moderation.'
                : 'This message is hidden due to moderation policy.',
            attachments: [],
            sender: null,
          };
        });
    const endCursor = items.length
      ? {
          createdAt: items[items.length - 1].createdAt.toISOString(),
          id: items[items.length - 1].id,
        }
      : null;

    return { items, hasNextPage, endCursor };
  }

  async getSummaryForActor(threadId: string, actorId: string, includeUnreadCount = false) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actorId } },
      select: { lastReadAt: true },
    });

    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        status: true,
        contextType: true,
        orderId: true,
        customOrderId: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        lastSenderUserId: true,
        updatedAt: true,
      },
    });

    if (!thread) return null;

    const unreadWhere = {
      threadId,
      visibilityState: 'VISIBLE' as const,
      ...(participant?.lastReadAt ? { createdAt: { gt: participant.lastReadAt } } : {}),
      senderUserId: { not: actorId },
    };

    const unreadCount = includeUnreadCount
      ? await this.prisma.message.count({ where: unreadWhere })
      : undefined;
    const hasUnread = includeUnreadCount ? (unreadCount ?? 0) > 0 : Boolean(
      await this.prisma.message.findFirst({ where: unreadWhere, select: { id: true } }),
    );

    return {
      ...thread,
      unreadCount,
      hasUnread,
      responseRequired: hasUnread,
    };
  }

  async getSummariesForActor(threadIds: string[], actorId: string, includeUnreadCount = false) {
    const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
    if (uniqueThreadIds.length === 0) {
      return {} as Record<string, {
        id: string;
        status: string;
        contextType: string;
        orderId: string | null;
        customOrderId: string | null;
        lastMessageAt: Date | null;
        lastMessagePreview: string | null;
        lastSenderUserId: string | null;
        updatedAt: Date;
        unreadCount?: number;
        hasUnread: boolean;
        responseRequired: boolean;
      }>;
    }

    const threads = await this.prisma.messageThread.findMany({
      where: { id: { in: uniqueThreadIds } },
      select: {
        id: true,
        status: true,
        contextType: true,
        orderId: true,
        customOrderId: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        lastSenderUserId: true,
        updatedAt: true,
      },
    });

    if (threads.length === 0) {
      return {} as Record<string, {
        id: string;
        status: string;
        contextType: string;
        orderId: string | null;
        customOrderId: string | null;
        lastMessageAt: Date | null;
        lastMessagePreview: string | null;
        lastSenderUserId: string | null;
        updatedAt: Date;
        unreadCount?: number;
        hasUnread: boolean;
        responseRequired: boolean;
      }>;
    }

    const unreadRows = includeUnreadCount
      ? await this.prisma.$queryRaw<Array<{ threadId: string; unreadCount: bigint | number }>>(Prisma.sql`
          SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS "unreadCount"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
          WHERE m."threadId" IN (${Prisma.join(threads.map((thread) => thread.id))})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${actorId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
          GROUP BY m."threadId"
        `)
      : await this.prisma.$queryRaw<Array<{ threadId: string }>>(Prisma.sql`
          SELECT DISTINCT m."threadId" AS "threadId"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
          WHERE m."threadId" IN (${Prisma.join(threads.map((thread) => thread.id))})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${actorId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
        `);

    const unreadCountByThreadId = new Map<string, number>();
    if (includeUnreadCount) {
      for (const row of unreadRows as Array<{ threadId: string; unreadCount: bigint | number }>) {
        unreadCountByThreadId.set(row.threadId, Number(row.unreadCount));
      }
    } else {
      for (const row of unreadRows as Array<{ threadId: string }>) {
        unreadCountByThreadId.set(row.threadId, 1);
      }
    }

    const summaries = threads.reduce((acc, thread) => {
      const unreadCount = unreadCountByThreadId.get(thread.id) ?? 0;
      const hasUnread = unreadCount > 0;
      acc[thread.id] = {
        ...thread,
        ...(includeUnreadCount ? { unreadCount } : {}),
        hasUnread,
        responseRequired: hasUnread,
      };
      return acc;
    }, {} as Record<string, {
      id: string;
      status: string;
      contextType: string;
      orderId: string | null;
      customOrderId: string | null;
      lastMessageAt: Date | null;
      lastMessagePreview: string | null;
      lastSenderUserId: string | null;
      updatedAt: Date;
      unreadCount?: number;
      hasUnread: boolean;
      responseRequired: boolean;
    }>);

    return summaries;
  }
}
