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

  async getUnreadMessageCountForActor(actorId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ unreadCount: bigint | number }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "unreadCount"
      FROM "Message" m
      INNER JOIN "MessageThreadParticipant" p
        ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
      WHERE p."archivedAt" IS NULL
        AND m."visibilityState" = 'VISIBLE'
        AND m."senderUserId" IS DISTINCT FROM ${actorId}
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
    `);

    return Number(rows[0]?.unreadCount ?? 0);
  }

  async getMessages(
    threadId: string,
    options?: { cursorCreatedAt?: string; cursorId?: string; limit?: number; actorId?: string },
    filters?: { includeModerated?: boolean },
  ) {
    const take = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const cursorCreatedAt = options?.cursorCreatedAt ? new Date(options.cursorCreatedAt) : null;
    const cursorId = options?.cursorId;
    const includeModerated = filters?.includeModerated === true;
    const actorId = options?.actorId;

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
        deliveryReceipts: {
          select: {
            recipientId: true,
            deliveredAt: true,
            readAt: true,
          },
        },
      },
    });

    const hasNextPage = messages.length > take;
    const rawItems = hasNextPage ? messages.slice(0, -1) : messages;

    // Fetch messaging privacy settings for the actor and thread participants
    const participantIds = await this.getThreadParticipantIds(threadId);
    const privacyMap = actorId ? await this.getMessagingPrivacy(participantIds) : new Map<string, { readReceipts: boolean; deliveryReceipts: boolean }>();
    const actorPrivacy = actorId ? (privacyMap.get(actorId) ?? { readReceipts: true, deliveryReceipts: true }) : { readReceipts: true, deliveryReceipts: true };

    const items = rawItems.map((message) => {
      if (!includeModerated && message.visibilityState !== MessageVisibilityState.VISIBLE) {
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
          deliveryReceipts: [],
          deliveryStatus: 'SENT' as const,
        };
      }

      // Compute delivery status for own messages
      let deliveryStatus: 'SENT' | 'DELIVERED' | 'READ' = 'SENT';
      if (actorId && message.senderUserId === actorId) {
        const otherParticipants = participantIds.filter((id) => id !== actorId);
        if (otherParticipants.length > 0) {
          const receipts = message.deliveryReceipts.filter((r) => otherParticipants.includes(r.recipientId));

          // Check if any recipient has delivery receipts turned off
          const allRecipientsAllowDelivery = otherParticipants.every((pid) => {
            const pp = privacyMap.get(pid);
            return pp ? pp.deliveryReceipts : true;
          });

          if (actorPrivacy.deliveryReceipts && allRecipientsAllowDelivery) {
            const allDelivered = otherParticipants.every((pid) =>
              receipts.some((r) => r.recipientId === pid && r.deliveredAt),
            );
            if (allDelivered) deliveryStatus = 'DELIVERED';

            // Check read — both sender and recipients must allow read receipts
            const allRecipientsAllowRead = otherParticipants.every((pid) => {
              const pp = privacyMap.get(pid);
              return pp ? pp.readReceipts : true;
            });

            if (allDelivered && actorPrivacy.readReceipts && allRecipientsAllowRead) {
              const allRead = otherParticipants.every((pid) =>
                receipts.some((r) => r.recipientId === pid && r.readAt),
              );
              if (allRead) deliveryStatus = 'READ';
            }
          }
        }
      }

      return {
        ...message,
        deliveryReceipts: [],
        deliveryStatus,
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

  /** Acknowledge delivery of messages for a recipient */
  async acknowledgeDelivery(threadId: string, recipientId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    // Check recipient's privacy setting
    const privacy = await this.getMessagingPrivacy([recipientId]);
    const recipientPrivacy = privacy.get(recipientId) ?? { readReceipts: true, deliveryReceipts: true };
    if (!recipientPrivacy.deliveryReceipts) return;

    const now = new Date();
    for (const messageId of messageIds) {
      await this.prisma.messageDeliveryReceipt.upsert({
        where: { messageId_recipientId: { messageId, recipientId } },
        create: { messageId, recipientId, deliveredAt: now },
        update: { deliveredAt: now },
      }).catch(() => { /* ignore duplicates or missing messages */ });
    }
  }

  /** Mark messages as read for a recipient (up to a given message) */
  async markMessagesRead(threadId: string, recipientId: string, upToMessageId: string): Promise<void> {
    const privacy = await this.getMessagingPrivacy([recipientId]);
    const recipientPrivacy = privacy.get(recipientId) ?? { readReceipts: true, deliveryReceipts: true };
    if (!recipientPrivacy.readReceipts) return;

    const upToMessage = await this.prisma.message.findFirst({
      where: { id: upToMessageId, threadId },
      select: { createdAt: true },
    });
    if (!upToMessage) return;

    // Find all messages in thread from other senders up to this point
    const messages = await this.prisma.message.findMany({
      where: {
        threadId,
        senderUserId: { not: recipientId },
        createdAt: { lte: upToMessage.createdAt },
        kind: 'USER',
        visibilityState: 'VISIBLE',
      },
      select: { id: true },
    });

    const now = new Date();
    for (const msg of messages) {
      await this.prisma.messageDeliveryReceipt.upsert({
        where: { messageId_recipientId: { messageId: msg.id, recipientId } },
        create: { messageId: msg.id, recipientId, deliveredAt: now, readAt: now },
        update: { readAt: now, ...(!recipientPrivacy.deliveryReceipts ? {} : { deliveredAt: now }) },
      }).catch(() => { /* ignore */ });
    }
  }

  private async getThreadParticipantIds(threadId: string): Promise<string[]> {
    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId },
      select: { userId: true },
    });
    return participants.map((p) => p.userId);
  }

  async getMessagingPrivacy(userIds: string[]): Promise<Map<string, { readReceipts: boolean; deliveryReceipts: boolean }>> {
    if (userIds.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, notificationSettings: true },
    });
    const map = new Map<string, { readReceipts: boolean; deliveryReceipts: boolean }>();
    for (const user of users) {
      const settings = user.notificationSettings as Record<string, any> | null;
      const messaging = settings?.messaging ?? {};
      map.set(user.id, {
        readReceipts: messaging.readReceipts !== false,
        deliveryReceipts: messaging.deliveryReceipts !== false,
      });
    }
    return map;
  }

  async getSummaryForActor(threadId: string, actorId: string, includeUnreadCount = false) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actorId } },
      select: { lastReadAt: true, mutedUntil: true, archivedAt: true },
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
      mutedUntil: participant?.mutedUntil ?? null,
      archivedAt: participant?.archivedAt ?? null,
      isMuted: Boolean(participant?.mutedUntil && participant.mutedUntil > new Date()),
      isArchivedByActor: Boolean(participant?.archivedAt),
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
        mutedUntil?: Date | null;
        archivedAt?: Date | null;
        isMuted?: boolean;
        isArchivedByActor?: boolean;
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
        mutedUntil?: Date | null;
        archivedAt?: Date | null;
        isMuted?: boolean;
        isArchivedByActor?: boolean;
      }>;
    }

    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: {
        threadId: { in: threads.map((thread) => thread.id) },
        userId: actorId,
      },
      select: {
        threadId: true,
        mutedUntil: true,
        archivedAt: true,
      },
    });
    const participantByThreadId = new Map(
      participants.map((entry) => [entry.threadId, entry]),
    );

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
      const participant = participantByThreadId.get(thread.id);
      acc[thread.id] = {
        ...thread,
        ...(includeUnreadCount ? { unreadCount } : {}),
        hasUnread,
        responseRequired: hasUnread,
        mutedUntil: participant?.mutedUntil ?? null,
        archivedAt: participant?.archivedAt ?? null,
        isMuted: Boolean(participant?.mutedUntil && participant.mutedUntil > new Date()),
        isArchivedByActor: Boolean(participant?.archivedAt),
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
      mutedUntil?: Date | null;
      archivedAt?: Date | null;
      isMuted?: boolean;
      isArchivedByActor?: boolean;
    }>);

    return summaries;
  }
}
