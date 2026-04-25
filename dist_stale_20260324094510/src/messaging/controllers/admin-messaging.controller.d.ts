import { Request } from 'express';
import { MessagingService } from '../messaging.service';
import { AdminSystemMessageDto, ModerateMessageDto, QueryInboxDto, QueryMessagesDto } from '../dto/messaging.dto';
export declare class AdminMessagingController {
    private readonly messaging;
    constructor(messaging: MessagingService);
    inbox(query: QueryInboxDto): Promise<{
        items: {
            threadId: string;
            contextType: string;
            orderId: string;
            customOrderId: string;
            status: import("@prisma/client").$Enums.MessageThreadStatus;
            title: string;
            subtitle: string;
            participants: {
                id: string;
                username: string;
                firstName: string;
                lastName: string;
                profileImage: string;
                role: import("@prisma/client").$Enums.MessageParticipantRole;
            }[];
            lastMessageAt: Date;
            createdAt: Date;
        }[];
        hasNextPage: boolean;
        endCursor: {
            cursorLastMessageAt: Date;
            cursorThreadId: string;
        };
    }>;
    getThread(req: Request & {
        user: {
            id: string;
        };
    }, threadId: string): Promise<{
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
    }>;
    getThreadMessages(req: Request & {
        user: {
            id: string;
        };
    }, threadId: string, query: QueryMessagesDto): Promise<{
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
    getCustomOrderMessages(orderId: string, query: QueryMessagesDto): Promise<{
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
    getOrderMessages(orderId: string, query: QueryMessagesDto): Promise<{
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
    hideMessage(req: Request & {
        user: {
            id: string;
        };
    }, messageId: string, dto: ModerateMessageDto): Promise<{
        success: boolean;
        messageId: string;
    }>;
    redactMessage(req: Request & {
        user: {
            id: string;
        };
    }, messageId: string, dto: ModerateMessageDto): Promise<{
        success: boolean;
        messageId: string;
    }>;
    reopenThread(req: Request & {
        user: {
            id: string;
        };
    }, threadId: string): Promise<{
        success: boolean;
        threadId: string;
    }>;
    addSystemMessage(req: Request & {
        user: {
            id: string;
        };
    }, threadId: string, dto: AdminSystemMessageDto): Promise<{
        success: boolean;
        messageId: string;
    }>;
}
