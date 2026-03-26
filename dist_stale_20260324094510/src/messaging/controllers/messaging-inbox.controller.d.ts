import { MessagingService } from '../messaging.service';
import { MarkThreadReadDto, QueryInboxDto, QueryMessagesDto, SendMessageDto } from '../dto/messaging.dto';
export declare class MessagingInboxController {
    private readonly messaging;
    constructor(messaging: MessagingService);
    inbox(req: {
        user: {
            id: string;
        };
    }, query: QueryInboxDto): Promise<{
        items: {
            threadId: string;
            contextType: string;
            orderId: string;
            customOrderId: string;
            inquiryId: any;
            title: string;
            subtitle: string;
            participant: {
                id: string;
                username: string;
                firstName: string;
                lastName: string;
                profileImage: string;
            };
            lastMessageAt: Date;
            createdAt: Date;
            unreadCount: number;
            hasUnread: boolean;
            mutedUntil: Date;
            archivedAt: Date;
            targetUrl: string;
        }[];
        hasNextPage: boolean;
        endCursor: {
            cursorLastMessageAt: Date;
            cursorThreadId: string;
        };
    }>;
    resolveThread(req: {
        user: {
            id: string;
        };
    }, threadId: string): Promise<{
        threadId: string;
        contextType: import("@prisma/client").$Enums.MessageContextType;
        orderId: string;
        customOrderId: string;
        inquiryType: string;
        targetUrl: string;
    }>;
    listThreadMessages(req: {
        user: {
            id: string;
        };
    }, threadId: string, query: QueryMessagesDto): Promise<{
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
    sendThreadMessage(req: {
        user: {
            id: string;
        };
    }, threadId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
    markThreadRead(req: {
        user: {
            id: string;
        };
    }, threadId: string, dto: MarkThreadReadDto): Promise<{
        success: boolean;
        threadId: string;
        lastReadMessageId: string;
    }>;
}
