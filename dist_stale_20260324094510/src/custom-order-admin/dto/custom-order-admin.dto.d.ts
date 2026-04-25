import { CustomOrderRetentionHoldType, CustomFabricRuleBasisStatus, CustomOrderDisputeResolution, CustomOrderDisputeStatus, CustomOrderProgressStage, CustomOrderStatus, Gender } from '@prisma/client';
export declare class ReviewCustomFabricRuleBasisDto {
    status: CustomFabricRuleBasisStatus;
    moderationNotes?: string;
}
export declare class QueryAdminCustomFabricRuleBasesDto {
    includeBrandOnly?: boolean;
}
export declare class CreateAdminCustomFabricRuleBasisDto {
    label: string;
    measurementKeys: string[];
    gender?: Gender;
}
export declare class UpdateAdminCustomFabricRuleBasisDto {
    label?: string;
    measurementKeys?: string[];
    gender?: Gender;
}
export declare class QueryAdminCustomOrdersDto {
    page?: number;
    limit?: number;
    status?: CustomOrderStatus;
    stage?: CustomOrderProgressStage;
    brandId?: string;
    q?: string;
}
export declare class QueryStaleCustomOrdersDto {
    page?: number;
    limit?: number;
    brandId?: string;
    escalatedOnly?: boolean;
}
export declare class QueryCustomOrderDisputesDto {
    page?: number;
    limit?: number;
    status?: CustomOrderDisputeStatus;
}
export declare class QueryCustomOrderLedgerAllocationsDto {
    page?: number;
    limit?: number;
    customOrderId?: string;
    brandId?: string;
    payoutId?: string;
}
export declare class ReleaseCustomOrderLedgerAllocationsDto {
    customOrderId?: string;
    brandId?: string;
    allocationIds?: string[];
    dryRun?: boolean;
}
export declare class QueryCustomOrderRiskDashboardDto {
    days?: number;
    limit?: number;
    brandId?: string;
}
export declare class QueryCustomOrderRefundReviewsDto {
    page?: number;
    limit?: number;
    brandId?: string;
    q?: string;
    includeSettled?: boolean;
}
export declare class UpdateCustomOrderDisputeDto {
    status?: CustomOrderDisputeStatus;
    resolution?: CustomOrderDisputeResolution;
    adminNotes?: string;
    assignedAdminId?: string;
}
export declare class AdminCustomOrderReminderDto {
    note?: string;
}
export declare class FlagCustomOrderRiskDto {
    reason: string;
    note?: string;
}
export declare class EscalateCustomOrderRefundReviewDto {
    reason: string;
    note?: string;
}
export declare class CancelPaidCustomOrderDto {
    reason: string;
    note?: string;
}
export declare class UpdateCustomOrderRetentionHoldDto {
    clear: boolean;
    holdType?: CustomOrderRetentionHoldType;
    reason?: string;
    holdUntil?: Date;
}
export declare class QueryCustomOrderExceptionReviewsDto {
    page?: number;
    limit?: number;
    brandId?: string;
    status?: 'NEW' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}
export declare class DecideCustomOrderExceptionReviewDto {
    decision: 'APPROVED' | 'REJECTED' | 'REQUEST_MORE_INFO';
    rationale: string;
    approvedQuoteTotal?: string;
}
