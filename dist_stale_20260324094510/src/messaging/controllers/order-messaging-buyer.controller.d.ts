import { Request } from 'express';
import { MessagingService } from '../messaging.service';
import { MarkThreadReadDto, OpenOrderDisputeDto, QueryMessagesDto, QueryThreadSummaryDto, RespondOrderExtensionDto, SendMessageDto, UpdateThreadPreferencesDto } from '../dto/messaging.dto';
export declare class OrderMessagingBuyerController {
    private readonly messaging;
    constructor(messaging: MessagingService);
    listMessages(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, query: QueryMessagesDto): Promise<{
        thread: {
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
            subjectSnapshotJson: import("@prisma/client/runtime/client").JsonValue | null;
            lastMessageId: string | null;
            lastMessageAt: Date | null;
            lastVisibleMessageAt: Date | null;
            lastMessagePreview: string | null;
            lastSenderUserId: string | null;
            readOnlyAt: Date | null;
        };
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
            metadataJson: import("@prisma/client/runtime/client").JsonValue | null;
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
    sendMessage(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, idempotencyKey: string | undefined, legacyIdempotencyKey: string | undefined, dto: SendMessageDto): Promise<{
        statusCode: number;
        replay: boolean;
        thread: {
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
            subjectSnapshotJson: import("@prisma/client/runtime/client").JsonValue | null;
            lastMessageId: string | null;
            lastMessageAt: Date | null;
            lastVisibleMessageAt: Date | null;
            lastMessagePreview: string | null;
            lastSenderUserId: string | null;
            readOnlyAt: Date | null;
        };
        message: {
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
            metadataJson: import("@prisma/client/runtime/client").JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    markRead(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, dto: MarkThreadReadDto): Promise<{
        success: boolean;
        threadId: any;
        lastReadMessageId?: undefined;
    } | {
        success: boolean;
        threadId: string;
        lastReadMessageId: string;
    }>;
    updatePreferences(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, dto: UpdateThreadPreferencesDto): Promise<{
        success: boolean;
        threadId: any;
        mutedUntil?: undefined;
        archivedAt?: undefined;
        lastReadMessageId?: undefined;
    } | {
        success: boolean;
        threadId: string;
        mutedUntil: Date;
        archivedAt: Date;
        lastReadMessageId: string;
    }>;
    summary(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, query: QueryThreadSummaryDto): Promise<{
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
    respondToExtension(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, requestMessageId: string, dto: RespondOrderExtensionDto): Promise<{
        statusCode: number;
        message: string;
        messageId: string;
    }>;
    openDispute(req: Request & {
        user: {
            id: string;
        };
    }, orderId: string, dto: OpenOrderDisputeDto): Promise<{
        statusCode: number;
        message: string;
        disputeId: string;
        messageId: string;
    }>;
}
