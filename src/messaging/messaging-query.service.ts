import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MessageKind,
  MessageParticipantRole,
  MessageVisibilityState,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  canonicalUserProfileSelect,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
import { resolveDisplayName } from 'src/common/display-name.helper';

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
    const rows = await this.prisma.$queryRaw<
      Array<{ unreadCount: bigint | number }>
    >(Prisma.sql`
      SELECT COUNT(*)::bigint AS "unreadCount"
      FROM "Message" m
      INNER JOIN "MessageThreadParticipant" p
        ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
      WHERE p."archivedAt" IS NULL
        AND m."visibilityState" = 'VISIBLE'
        AND m."senderUserId" IS DISTINCT FROM ${actorId}
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"
          OR (m."createdAt" = p."lastReadAt" AND (p."lastReadMessageId" IS NULL OR m."id" > p."lastReadMessageId")))
    `);

    return Number(rows[0]?.unreadCount ?? 0);
  }

  async getMessages(
    threadId: string,
    options?: {
      cursorCreatedAt?: string;
      cursorId?: string;
      limit?: number;
      actorId?: string;
    },
    filters?: { includeModerated?: boolean },
  ) {
    const take = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const cursorCreatedAt = options?.cursorCreatedAt
      ? new Date(options.cursorCreatedAt)
      : null;
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
            // `type` + `brand.name` are what let `resolveDisplayName` label a
            // brand thread with the STOREFRONT rather than the owner's given
            // name. Without them selected the resolver cannot tell the two
            // kinds of account apart and silently falls back to the person.
            type: true,
            brand: { select: { name: true } },
            userProfile: { select: canonicalUserProfileSelect },
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
        replyTo: {
          select: {
            id: true,
            bodyText: true,
            senderRole: true,
            senderUserId: true,
            sender: {
              select: {
                id: true,
                username: true,
                type: true,
                brand: { select: { name: true } },
                userProfile: { select: canonicalUserProfileSelect },
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
    const privacyMap = actorId
      ? await this.getMessagingPrivacy(participantIds)
      : new Map<string, { readReceipts: boolean; deliveryReceipts: boolean }>();
    const actorPrivacy = actorId
      ? (privacyMap.get(actorId) ?? {
          readReceipts: true,
          deliveryReceipts: true,
        })
      : { readReceipts: true, deliveryReceipts: true };

    const items = rawItems.map((message) => {
      if (
        !includeModerated &&
        message.visibilityState !== MessageVisibilityState.VISIBLE
      ) {
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
          const receipts = message.deliveryReceipts.filter((r) =>
            otherParticipants.includes(r.recipientId),
          );

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

            if (
              allDelivered &&
              actorPrivacy.readReceipts &&
              allRecipientsAllowRead
            ) {
              const allRead = otherParticipants.every((pid) =>
                receipts.some((r) => r.recipientId === pid && r.readAt),
              );
              if (allRead) deliveryStatus = 'READ';
            }
          }
        }
      }

      const replyToRaw = (message as any).replyTo as {
        id: string;
        bodyText: string | null;
        senderRole: string;
        senderUserId: string | null;
        sender: {
          id: string;
          username: string | null;
          userProfile: any;
        } | null;
      } | null;

      return {
        ...message,
        sender: message.sender
          ? {
              id: message.sender.id,
              username: message.sender.username,
              firstName: resolveRequiredProfileField(
                message.sender,
                'firstName',
              ),
              lastName: resolveRequiredProfileField(message.sender, 'lastName'),
              // Canonical, and the field clients should render. The raw parts
              // stay for compatibility, but joining them is not the caller's
              // job — a brand must read as its brand name, not "first last".
              displayName: resolveDisplayName(
                message.sender,
                message.senderRole === 'BRAND_OWNER' ? 'Brand' : 'User',
              ),
              profileImage: resolveProfileImage(message.sender).url,
            }
          : null,
        quotedMessage: replyToRaw
          ? {
              id: replyToRaw.id,
              bodyText: replyToRaw.bodyText,
              senderRole: replyToRaw.senderRole,
              senderName: resolveDisplayName(
                replyToRaw.sender,
                replyToRaw.senderRole,
              ),
            }
          : null,
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

  /**
   * Acknowledge delivery of messages for a recipient.
   *
   * Returns whether receipts were actually written. The caller uses this to
   * decide whether the sender may be told "delivered": a recipient who has
   * turned delivery receipts off records nothing, and `deliveryStatus` will
   * keep computing SENT for them. Emitting a delivered event regardless would
   * put a second tick on screen that the next fetch takes straight back off.
   */
  async acknowledgeDelivery(
    threadId: string,
    recipientId: string,
    messageIds: string[],
  ): Promise<boolean> {
    if (messageIds.length === 0) return false;

    // Check recipient's privacy setting
    const privacy = await this.getMessagingPrivacy([recipientId]);
    const recipientPrivacy = privacy.get(recipientId) ?? {
      readReceipts: true,
      deliveryReceipts: true,
    };
    if (!recipientPrivacy.deliveryReceipts) return false;

    const unique = Array.from(new Set(messageIds));
    for (let index = 0; index < unique.length; index += 500) {
      const ids = unique.slice(index, index + 500);
      await this.prisma.$executeRaw`
        INSERT INTO "MessageDeliveryReceipt"("id","messageId","recipientId","deliveredAt","createdAt")
        SELECT gen_random_uuid(),m."id",${recipientId}::uuid,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        FROM "Message" m
        WHERE m."threadId"=${threadId}::uuid AND m."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          AND m."senderUserId" IS DISTINCT FROM ${recipientId}::uuid
        ORDER BY m."id"
        ON CONFLICT ("messageId","recipientId") DO UPDATE
          SET "deliveredAt"=COALESCE("MessageDeliveryReceipt"."deliveredAt",EXCLUDED."deliveredAt")
      `;
    }
    return true;
  }

  /** Mark messages as read for a recipient (up to a given message) */
  async markMessagesRead(
    threadId: string,
    recipientId: string,
    upToMessageId: string,
  ): Promise<void> {
    const privacy = await this.getMessagingPrivacy([recipientId]);
    const recipientPrivacy = privacy.get(recipientId) ?? {
      readReceipts: true,
      deliveryReceipts: true,
    };
    if (!recipientPrivacy.readReceipts) return;

    // Join directly to the requested watermark and existing receipts; no per-message query loop.
    await this.prisma.$executeRaw`
      INSERT INTO "MessageDeliveryReceipt"("id","messageId","recipientId","deliveredAt","readAt","createdAt")
      SELECT gen_random_uuid(),m."id",${recipientId}::uuid,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      FROM "Message" m
      JOIN "Message" watermark ON watermark."id"=${upToMessageId}::uuid AND watermark."threadId"=${threadId}::uuid
      LEFT JOIN "MessageDeliveryReceipt" receipt ON receipt."messageId"=m."id" AND receipt."recipientId"=${recipientId}::uuid
      WHERE m."threadId"=${threadId}::uuid
        AND (m."createdAt",m."id")<=(watermark."createdAt",watermark."id")
        AND m."senderUserId" IS DISTINCT FROM ${recipientId}::uuid
        AND m."kind"='USER' AND m."visibilityState"='VISIBLE' AND receipt."readAt" IS NULL
      ORDER BY m."id"
      ON CONFLICT ("messageId","recipientId") DO UPDATE
        SET "readAt"=COALESCE("MessageDeliveryReceipt"."readAt",EXCLUDED."readAt"),
            "deliveredAt"=CASE WHEN ${recipientPrivacy.deliveryReceipts} THEN COALESCE("MessageDeliveryReceipt"."deliveredAt",EXCLUDED."deliveredAt") ELSE "MessageDeliveryReceipt"."deliveredAt" END
    `;
  }

  private async getThreadParticipantIds(threadId: string): Promise<string[]> {
    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId },
      select: { userId: true },
    });
    return participants.map((p) => p.userId);
  }

  async getMessagingPrivacy(
    userIds: string[],
  ): Promise<
    Map<string, { readReceipts: boolean; deliveryReceipts: boolean }>
  > {
    if (userIds.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, notificationSettings: true },
    });
    const map = new Map<
      string,
      { readReceipts: boolean; deliveryReceipts: boolean }
    >();
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

  async getSummaryForActor(
    threadId: string,
    actorId: string,
    includeUnreadCount = false,
  ) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actorId } },
      select: { lastReadAt: true, lastReadMessageId: true, mutedUntil: true, archivedAt: true },
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
      ...(participant?.lastReadAt
        ? { OR: [
            { createdAt: { gt: participant.lastReadAt } },
            { createdAt: participant.lastReadAt, ...(participant.lastReadMessageId ? { id: { gt: participant.lastReadMessageId } } : {}) },
          ] }
        : {}),
      senderUserId: { not: actorId },
    };

    const unreadCount = includeUnreadCount
      ? await this.prisma.message.count({ where: unreadWhere })
      : undefined;
    const hasUnread = includeUnreadCount
      ? (unreadCount ?? 0) > 0
      : Boolean(
          await this.prisma.message.findFirst({
            where: unreadWhere,
            select: { id: true },
          }),
        );

    return {
      ...thread,
      unreadCount,
      hasUnread,
      responseRequired: hasUnread,
      mutedUntil: participant?.mutedUntil ?? null,
      archivedAt: participant?.archivedAt ?? null,
      isMuted: Boolean(
        participant?.mutedUntil && participant.mutedUntil > new Date(),
      ),
      isArchivedByActor: Boolean(participant?.archivedAt),
    };
  }

  async getSummariesForActor(
    threadIds: string[],
    actorId: string,
    includeUnreadCount = false,
  ) {
    const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
    if (uniqueThreadIds.length === 0) {
      return {} as Record<
        string,
        {
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
        }
      >;
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
      return {} as Record<
        string,
        {
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
        }
      >;
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
      ? await this.prisma.$queryRaw<
          Array<{ threadId: string; unreadCount: bigint | number }>
        >(Prisma.sql`
          SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS "unreadCount"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
          WHERE m."threadId" IN (${Prisma.join(threads.map((thread) => thread.id))})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${actorId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"
          OR (m."createdAt" = p."lastReadAt" AND (p."lastReadMessageId" IS NULL OR m."id" > p."lastReadMessageId")))
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
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"
          OR (m."createdAt" = p."lastReadAt" AND (p."lastReadMessageId" IS NULL OR m."id" > p."lastReadMessageId")))
        `);

    const unreadCountByThreadId = new Map<string, number>();
    if (includeUnreadCount) {
      for (const row of unreadRows as Array<{
        threadId: string;
        unreadCount: bigint | number;
      }>) {
        unreadCountByThreadId.set(row.threadId, Number(row.unreadCount));
      }
    } else {
      for (const row of unreadRows as Array<{ threadId: string }>) {
        unreadCountByThreadId.set(row.threadId, 1);
      }
    }

    const summaries = threads.reduce(
      (acc, thread) => {
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
          isMuted: Boolean(
            participant?.mutedUntil && participant.mutedUntil > new Date(),
          ),
          isArchivedByActor: Boolean(participant?.archivedAt),
        };
        return acc;
      },
      {} as Record<
        string,
        {
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
        }
      >,
    );

    return summaries;
  }
}
