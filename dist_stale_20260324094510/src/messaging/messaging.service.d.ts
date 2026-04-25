import { MessageContextType, Prisma } from '@prisma/client';
import { Request } from 'express';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { CustomOrdersService } from 'src/custom-orders/custom-orders.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';
import { AdminSystemMessageDto, BulkQueryThreadSummaryDto, MarkThreadReadDto, OpenCustomOrderDisputeDto, OpenOrderDisputeDto, QueryInboxDto, QueryMessagesDto, QueryThreadSummaryDto, RequestCustomOrderExtensionDto, RequestOrderExtensionDto, RespondCustomOrderExtensionDto, RespondOrderExtensionDto, SendMessageDto, UpdateThreadPreferencesDto } from './dto/messaging.dto';
export declare class MessagingService {
    private readonly prisma;
    private readonly adminAudit;
    private readonly attachments;
    private readonly policy;
    private readonly query;
    private readonly sideEffects;
    private readonly customOrdersService;
    private readonly logger;
    constructor(prisma: PrismaService, adminAudit: AdminAuditService, attachments: MessagingAttachmentService, policy: MessagingPolicyService, query: MessagingQueryService, sideEffects: MessagingSideEffectsService, customOrdersService: CustomOrdersService);
    listCustomOrderMessagesForBuyer(actorId: string, customOrderId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    listCustomOrderMessagesForBrand(actorId: string, brandId: string, customOrderId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    listOrderMessagesForBuyer(actorId: string, orderId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    listOrderMessagesForBrand(actorId: string, brandId: string, orderId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    listThreadMessagesForActor(actorId: string, threadId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    sendCustomOrderMessageForBuyer(actorId: string, customOrderId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    sendCustomOrderMessageForBrand(actorId: string, brandId: string, customOrderId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    sendOrderMessageForBuyer(actorId: string, orderId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    sendOrderMessageForBrand(actorId: string, brandId: string, orderId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    sendMessageToThread(actorId: string, threadId: string, dto: SendMessageDto, idempotencyKey?: string): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
            metadataJson: Prisma.JsonValue | null;
            moderatedById: string | null;
            moderatedAt: Date | null;
            moderationReason: string | null;
        };
    }>;
    requestOrderExtensionForBrand(actorId: string, brandId: string, orderId: string, dto: RequestOrderExtensionDto): Promise<{
        statusCode: number;
        message: string;
        requestMessageId: string;
    }>;
    getInboxForActor(actorId: string, queryDto: QueryInboxDto): Promise<{
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
    resolveThreadForActor(actorId: string, threadId: string): Promise<{
        threadId: string;
        contextType: import("@prisma/client").$Enums.MessageContextType;
        orderId: string;
        customOrderId: string;
        inquiryType: string;
        targetUrl: string;
    }>;
    markThreadReadById(actorId: string, threadId: string, dto: MarkThreadReadDto): Promise<{
        success: boolean;
        threadId: string;
        lastReadMessageId: string;
    }>;
    respondToOrderExtensionForBuyer(actorId: string, orderId: string, requestMessageId: string, dto: RespondOrderExtensionDto): Promise<{
        statusCode: number;
        message: string;
        messageId: string;
    }>;
    openOrderDisputeForBuyer(actorId: string, orderId: string, dto: OpenOrderDisputeDto): Promise<{
        statusCode: number;
        message: string;
        disputeId: string;
        messageId: string;
    }>;
    openOrderDisputeForBrand(actorId: string, brandId: string, orderId: string, dto: OpenOrderDisputeDto): Promise<{
        statusCode: number;
        message: string;
        disputeId: string;
        messageId: string;
    }>;
    requestCustomOrderExtensionForBrand(actorId: string, brandId: string, customOrderId: string, dto: RequestCustomOrderExtensionDto): Promise<{
        messageThreadEventId: string;
        extensionRequestId: any;
        statusCode: number;
        message: string;
        data: {
            id: any;
            status: any;
            paymentStatus: any;
            paymentReference: any;
            source: {
                type: any;
                id: any;
                title: any;
                slug: any;
                primaryMediaUrl: any;
                brandName: any;
            };
            configurationVersionId: any;
            buyerPriceSummary: any;
            internalPriceBreakdown: any;
            quoteStatus: string;
            chartLock: Record<string, unknown>;
            exceptionDecision: Record<string, unknown> | null;
            measurementSnapshot: any;
            measurementConfirmedAt: any;
            currentProgressStage: any;
            acceptedAt: any;
            buyerAcceptedAt: any;
            completedAt: any;
            promisedProductionAt: any;
            promisedDispatchAt: any;
            promisedDeliveryAt: any;
            buyerAcceptanceWindowEndsAt: any;
            measurementRetentionUntil: any;
            anonymizedAt: any;
            retentionHoldType: any;
            retentionHoldReason: any;
            retentionHoldUntil: any;
            retentionHoldSetById: any;
            retentionHoldSetAt: any;
            progressEvents: any;
            extensionRequests: any;
            issues: any;
            disputes: any;
            timelineEvents: any;
            createdAt: any;
            updatedAt: any;
        };
    }>;
    respondToCustomOrderExtensionForBuyer(actorId: string, customOrderId: string, requestId: string, dto: RespondCustomOrderExtensionDto): Promise<{
        messageThreadEventId: string;
        statusCode: number;
        message: string;
        data: {
            id: any;
            status: any;
            paymentStatus: any;
            paymentReference: any;
            source: {
                type: any;
                id: any;
                title: any;
                slug: any;
                primaryMediaUrl: any;
                brandName: any;
            };
            configurationVersionId: any;
            buyerPriceSummary: any;
            internalPriceBreakdown: any;
            quoteStatus: string;
            chartLock: Record<string, unknown>;
            exceptionDecision: Record<string, unknown> | null;
            measurementSnapshot: any;
            measurementConfirmedAt: any;
            currentProgressStage: any;
            acceptedAt: any;
            buyerAcceptedAt: any;
            completedAt: any;
            promisedProductionAt: any;
            promisedDispatchAt: any;
            promisedDeliveryAt: any;
            buyerAcceptanceWindowEndsAt: any;
            measurementRetentionUntil: any;
            anonymizedAt: any;
            retentionHoldType: any;
            retentionHoldReason: any;
            retentionHoldUntil: any;
            retentionHoldSetById: any;
            retentionHoldSetAt: any;
            progressEvents: any;
            extensionRequests: any;
            issues: any;
            disputes: any;
            timelineEvents: any;
            createdAt: any;
            updatedAt: any;
        };
    }>;
    openCustomOrderDisputeForBuyer(actorId: string, customOrderId: string, dto: OpenCustomOrderDisputeDto): Promise<{
        messageThreadEventId: string;
        statusCode: number;
        message: string;
        data: {
            id: any;
            status: any;
            paymentStatus: any;
            paymentReference: any;
            source: {
                type: any;
                id: any;
                title: any;
                slug: any;
                primaryMediaUrl: any;
                brandName: any;
            };
            configurationVersionId: any;
            buyerPriceSummary: any;
            internalPriceBreakdown: any;
            quoteStatus: string;
            chartLock: Record<string, unknown>;
            exceptionDecision: Record<string, unknown> | null;
            measurementSnapshot: any;
            measurementConfirmedAt: any;
            currentProgressStage: any;
            acceptedAt: any;
            buyerAcceptedAt: any;
            completedAt: any;
            promisedProductionAt: any;
            promisedDispatchAt: any;
            promisedDeliveryAt: any;
            buyerAcceptanceWindowEndsAt: any;
            measurementRetentionUntil: any;
            anonymizedAt: any;
            retentionHoldType: any;
            retentionHoldReason: any;
            retentionHoldUntil: any;
            retentionHoldSetById: any;
            retentionHoldSetAt: any;
            progressEvents: any;
            extensionRequests: any;
            issues: any;
            disputes: any;
            timelineEvents: any;
            createdAt: any;
            updatedAt: any;
        };
    }>;
    openCustomOrderDisputeForBrand(actorId: string, brandId: string, customOrderId: string, dto: OpenCustomOrderDisputeDto): Promise<{
        statusCode: number;
        message: string;
        disputeId: string;
        messageId: string;
    }>;
    markThreadReadForContext(actorId: string, contextType: MessageContextType, contextId: string, role: 'BUYER' | 'BRAND_OWNER', dto: MarkThreadReadDto, brandId?: string): Promise<{
        success: boolean;
        threadId: any;
        lastReadMessageId?: undefined;
    } | {
        success: boolean;
        threadId: string;
        lastReadMessageId: string;
    }>;
    updateThreadPreferencesForContext(actorId: string, contextType: MessageContextType, contextId: string, role: 'BUYER' | 'BRAND_OWNER', dto: UpdateThreadPreferencesDto, brandId?: string): Promise<{
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
    getSummaryForContext(actorId: string, contextType: MessageContextType, contextId: string, role: 'BUYER' | 'BRAND_OWNER', queryDto: QueryThreadSummaryDto, brandId?: string): Promise<{
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
    getBulkSummariesForCustomOrdersBuyer(actorId: string, queryDto: BulkQueryThreadSummaryDto): Promise<{
        items: {
            contextId: string;
            summary: {
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
            };
        }[];
    }>;
    getBulkSummariesForCustomOrdersBrand(actorId: string, brandId: string, queryDto: BulkQueryThreadSummaryDto): Promise<{
        items: {
            contextId: string;
            summary: {
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
            };
        }[];
    }>;
    getBulkSummariesForOrdersBuyer(actorId: string, queryDto: BulkQueryThreadSummaryDto): Promise<{
        items: {
            contextId: string;
            summary: {
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
            };
        }[];
    }>;
    getBulkSummariesForOrdersBrand(actorId: string, brandId: string, queryDto: BulkQueryThreadSummaryDto): Promise<{
        items: {
            contextId: string;
            summary: {
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
            };
        }[];
    }>;
    getAdminInbox(queryDto: QueryInboxDto): Promise<{
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
    getAdminThread(actorId: string, threadId: string): Promise<{
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
    getAdminThreadMessages(actorId: string, threadId: string, queryDto: QueryMessagesDto): Promise<{
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
    getAdminMessagesForContext(contextType: MessageContextType, contextId: string, queryDto: QueryMessagesDto): Promise<{
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
            subjectSnapshotJson: Prisma.JsonValue | null;
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
    hideMessage(actorId: string, messageId: string, reason?: string, req?: Request): Promise<{
        success: boolean;
        messageId: string;
    }>;
    redactMessage(actorId: string, messageId: string, reason?: string, req?: Request): Promise<{
        success: boolean;
        messageId: string;
    }>;
    reopenThread(actorId: string, threadId: string, req?: Request): Promise<{
        success: boolean;
        threadId: string;
    }>;
    addSystemMessage(actorId: string, threadId: string, dto: AdminSystemMessageDto, req?: Request): Promise<{
        success: boolean;
        messageId: string;
    }>;
    private sendMessageInContext;
    private getOrCreateThreadForCustomOrder;
    private getOrCreateThreadForOrder;
    private getOrCreateThreadInTx;
    private getThreadByContext;
    private normalizeContextIds;
    private getBulkSummariesForContext;
    private getThreadOrThrow;
    private resolveCustomOrderContext;
    private resolveStandardOrderContext;
    private resolveCurrentThreadStatusInTx;
    private notifyModeration;
    private openStandardOrderDispute;
    private createActionMessageForContext;
    private resolveThreadTargetUrl;
}
