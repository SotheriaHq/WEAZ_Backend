import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
export declare class MessagingQueryService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    getThreadById(threadId: string): Promise<{
        participants: {
            id: string;
            role: import("@prisma/client").$Enums.MessageParticipantRole;
            userId: string;
            threadId: string;
            joinedAt: Date;
            lastReadMessageId: string | null;
            lastReadAt: Date | null;
            mutedUntil: Date | null;
            archivedAt: Date | null;
        }[];
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MessageThreadStatus;
        brandId: string | null;
        buyerId: string | null;
        archivedAt: Date | null;
        orderId: string | null;
        contextType: import("@prisma/client").$Enums.MessageContextType;
        customOrderId: string | null;
        subjectSnapshotJson: Prisma.JsonValue | null;
        lastMessageId: string | null;
        lastMessageAt: Date | null;
        lastVisibleMessageAt: Date | null;
        lastMessagePreview: string | null;
        lastSenderUserId: string | null;
        readOnlyAt: Date | null;
    }>;
    getMessages(threadId: string, options?: {
        cursorCreatedAt?: string;
        cursorId?: string;
        limit?: number;
    }, filters?: {
        includeModerated?: boolean;
    }): Promise<{
        items: ({
            sender: {
                id: string;
                username: string;
                firstName: string;
                lastName: string;
                profileImage: string;
            };
            attachments: ({
                file: {
                    id: string;
                    originalName: string;
                    fileName: string;
                    s3Url: string;
                    mimeType: string;
                    size: number;
                };
            } & {
                id: string;
                createdAt: Date;
                kind: import("@prisma/client").$Enums.MessageAttachmentKind;
                fileUploadId: string;
                messageId: string;
            })[];
        } & {
            id: string;
            createdAt: Date;
            editedAt: Date | null;
            threadId: string;
            senderUserId: string | null;
            senderRole: import("@prisma/client").$Enums.MessageParticipantRole;
            kind: import("@prisma/client").$Enums.MessageKind;
            visibilityState: import("@prisma/client").$Enums.MessageVisibilityState;
            clientMessageId: string | null;
            bodyText: string | null;
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        })[];
        hasNextPage: boolean;
        endCursor: {
            createdAt: string;
            id: string;
        };
    }>;
    getSummaryForActor(threadId: string, actorId: string, includeUnreadCount?: boolean): Promise<{
        unreadCount: number;
        hasUnread: boolean;
        responseRequired: boolean;
        mutedUntil: Date;
        archivedAt: Date;
        isMuted: boolean;
        isArchivedByActor: boolean;
        id: string;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.MessageThreadStatus;
        orderId: string;
        contextType: import("@prisma/client").$Enums.MessageContextType;
        customOrderId: string;
        lastMessageAt: Date;
        lastMessagePreview: string;
        lastSenderUserId: string;
    }>;
    getSummariesForActor(threadIds: string[], actorId: string, includeUnreadCount?: boolean): Promise<Record<string, {
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
    }>>;
}
