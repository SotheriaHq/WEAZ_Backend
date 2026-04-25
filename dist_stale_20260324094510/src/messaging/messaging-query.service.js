"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingQueryService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const client_2 = require("@prisma/client");
const prisma_service_1 = require("../prisma/prisma.service");
let MessagingQueryService = class MessagingQueryService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getThreadById(threadId) {
        return this.prisma.messageThread.findUnique({
            where: { id: threadId },
            include: {
                participants: true,
            },
        });
    }
    async getMessages(threadId, options, filters) {
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
                if (message.visibilityState === client_2.MessageVisibilityState.VISIBLE) {
                    return message;
                }
                return {
                    ...message,
                    senderUserId: null,
                    senderRole: client_2.MessageParticipantRole.SYSTEM,
                    kind: client_2.MessageKind.MODERATION_NOTICE,
                    bodyText: message.visibilityState === client_2.MessageVisibilityState.REDACTED
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
    async getSummaryForActor(threadId, actorId, includeUnreadCount = false) {
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
        if (!thread)
            return null;
        const unreadWhere = {
            threadId,
            visibilityState: 'VISIBLE',
            ...(participant?.lastReadAt ? { createdAt: { gt: participant.lastReadAt } } : {}),
            senderUserId: { not: actorId },
        };
        const unreadCount = includeUnreadCount
            ? await this.prisma.message.count({ where: unreadWhere })
            : undefined;
        const hasUnread = includeUnreadCount ? (unreadCount ?? 0) > 0 : Boolean(await this.prisma.message.findFirst({ where: unreadWhere, select: { id: true } }));
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
    async getSummariesForActor(threadIds, actorId, includeUnreadCount = false) {
        const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
        if (uniqueThreadIds.length === 0) {
            return {};
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
            return {};
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
        const participantByThreadId = new Map(participants.map((entry) => [entry.threadId, entry]));
        const unreadRows = includeUnreadCount
            ? await this.prisma.$queryRaw(client_1.Prisma.sql `
          SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS "unreadCount"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
          WHERE m."threadId" IN (${client_1.Prisma.join(threads.map((thread) => thread.id))})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${actorId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
          GROUP BY m."threadId"
        `)
            : await this.prisma.$queryRaw(client_1.Prisma.sql `
          SELECT DISTINCT m."threadId" AS "threadId"
          FROM "Message" m
          LEFT JOIN "MessageThreadParticipant" p
            ON p."threadId" = m."threadId" AND p."userId" = ${actorId}
          WHERE m."threadId" IN (${client_1.Prisma.join(threads.map((thread) => thread.id))})
            AND m."visibilityState" = 'VISIBLE'
            AND m."senderUserId" IS DISTINCT FROM ${actorId}
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
        `);
        const unreadCountByThreadId = new Map();
        if (includeUnreadCount) {
            for (const row of unreadRows) {
                unreadCountByThreadId.set(row.threadId, Number(row.unreadCount));
            }
        }
        else {
            for (const row of unreadRows) {
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
        }, {});
        return summaries;
    }
};
exports.MessagingQueryService = MessagingQueryService;
exports.MessagingQueryService = MessagingQueryService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], MessagingQueryService);
//# sourceMappingURL=messaging-query.service.js.map