import { Request } from 'express';
import { MessagingService } from '../messaging.service';
import { BulkQueryThreadSummaryDto } from '../dto/messaging.dto';
export declare class MessagingSummaryBuyerController {
    private readonly messaging;
    constructor(messaging: MessagingService);
    customOrderSummaries(req: Request & {
        user: {
            id: string;
        };
    }, dto: BulkQueryThreadSummaryDto): Promise<{
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
    orderSummaries(req: Request & {
        user: {
            id: string;
        };
    }, dto: BulkQueryThreadSummaryDto): Promise<{
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
}
