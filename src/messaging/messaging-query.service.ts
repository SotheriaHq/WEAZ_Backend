import { Injectable } from '@nestjs/common';
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

  async getMessages(threadId: string, options?: { cursorCreatedAt?: string; cursorId?: string; limit?: number }) {
    const take = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const cursorCreatedAt = options?.cursorCreatedAt ? new Date(options.cursorCreatedAt) : null;
    const cursorId = options?.cursorId;

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
    const items = hasNextPage ? messages.slice(0, -1) : messages;
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
}
