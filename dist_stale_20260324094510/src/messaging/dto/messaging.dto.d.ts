export declare class QueryMessagesDto {
    cursorCreatedAt?: string;
    cursorId?: string;
    limit?: number;
}
export declare class QueryInboxDto {
    cursorLastMessageAt?: string;
    cursorThreadId?: string;
    limit?: number;
    filter?: 'all' | 'unread' | 'archived';
    contextType?: 'all' | 'STANDARD_ORDER' | 'CUSTOM_ORDER' | 'INQUIRY';
    q?: string;
}
export declare class SendMessageDto {
    clientMessageId: string;
    bodyText?: string;
    attachmentFileIds?: string[];
}
export declare class MarkThreadReadDto {
    upToMessageId?: string;
}
export declare class UpdateThreadPreferencesDto {
    archived?: boolean;
    markRead?: boolean;
    muteForHours?: number;
    unmute?: boolean;
}
export declare class ModerateMessageDto {
    reason?: string;
}
export declare class AdminSystemMessageDto {
    bodyText: string;
}
export declare class QueryThreadSummaryDto {
    includeUnreadCount?: string;
}
export declare class BulkQueryThreadSummaryDto {
    contextIds: string[];
    includeUnreadCount?: string;
}
export declare class RequestOrderExtensionDto {
    requestedExtraDays: number;
    reason: string;
}
export declare class RespondOrderExtensionDto {
    response: 'ACCEPTED' | 'REJECTED' | 'COUNTERED';
    counterDays?: number;
    note?: string;
}
export declare class OpenOrderDisputeDto {
    description: string;
}
export declare class RequestCustomOrderExtensionDto {
    targetType: 'PRODUCTION' | 'DELIVERY' | 'BOTH';
    requestedExtraDays: number;
    reason: string;
}
export declare class RespondCustomOrderExtensionDto {
    response: 'ACCEPTED' | 'REJECTED' | 'COUNTERED';
    counterDays?: number;
}
export declare class OpenCustomOrderDisputeDto {
    issueType: 'WRONG_ITEM' | 'MATERIAL_DEFECT' | 'MEASUREMENT_NON_COMPLIANCE' | 'UNFINISHED_WORK' | 'NON_DELIVERY' | 'UNREASONABLE_DELAY' | 'OTHER';
    description: string;
    evidenceJson?: Record<string, unknown>;
}
