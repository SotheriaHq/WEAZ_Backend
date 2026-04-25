import { CustomOrderExtensionResponseStatus, CustomOrderExtensionTargetType, CustomOrderIssueType, CustomOrderProgressStage, CustomOrderStatus, PaymentMethod } from '@prisma/client';
export type CustomOrderChartFamily = 'UK' | 'US' | 'NIGERIA' | 'ASIA' | 'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA';
export type CustomOrderResolverPolicy = 'PRIMARY_ONLY' | 'MAX_OF_BOTH' | 'WEIGHTED_AVERAGE_TO_NEAREST_BAND';
export declare class CustomOrderPricePreviewDto {
    configurationId: string;
    configurationVersionId?: string;
    measurementValues: Record<string, number>;
    rushSelected?: boolean;
    shippingAddress?: Record<string, unknown>;
    idempotencyKey?: string;
    pricingChartFamily?: CustomOrderChartFamily;
    displayChartFamily?: CustomOrderChartFamily;
    resolverPolicy?: CustomOrderResolverPolicy;
}
export declare class CreateCustomOrderDto {
    checkoutIntentId: string;
    configurationId: string;
    configurationVersionId?: string;
    measurementValues: Record<string, number>;
    rushSelected: boolean;
    shippingAddress: Record<string, unknown>;
    contactInfo: Record<string, unknown>;
    customerName: string;
    idempotencyKey: string;
    noDirectMatchAcknowledged?: boolean;
}
export declare class UpdateDisplayChartPreferenceDto {
    displayChartFamily: CustomOrderChartFamily;
    updatedAtMs?: number;
}
export declare class CreateExceptionReviewRequestDto {
    reason: string;
    requestedQuoteTotal?: string;
}
export declare class InitializeCustomOrderPaymentDto {
    paymentMethod: PaymentMethod;
    email: string;
    callbackUrl?: string;
    paymentData?: Record<string, unknown>;
    idempotencyKey: string;
}
export declare class VerifyCustomOrderPaymentDto {
    reference: string;
    gateway: string;
    otp?: string;
    statusHint?: string;
}
export declare class CancelCustomOrderDto {
    reason: string;
}
export declare class ConfirmCustomOrderDeliveryDto {
    note?: string;
}
export declare class ReportCustomOrderIssueDto {
    issueType: CustomOrderIssueType;
    description: string;
    evidenceJson?: Record<string, unknown>;
}
export declare class UpdateCustomOrderMeasurementsDto {
    measurementValues: Record<string, number>;
    reason?: string;
}
export declare class RespondToCustomOrderExtensionDto {
    response: CustomOrderExtensionResponseStatus;
    counterDays?: number;
}
export declare class AcceptCustomOrderDto {
    note?: string;
}
export declare class RejectCustomOrderDto {
    reason: string;
}
export declare class UpdateCustomOrderProgressStageDto {
    stage: CustomOrderProgressStage;
    note?: string;
}
export declare class CreateCustomOrderExtensionRequestDto {
    targetType: CustomOrderExtensionTargetType;
    requestedExtraDays: number;
    reason: string;
}
export declare class BrandRespondToCustomOrderExtensionCounterDto {
    response: CustomOrderExtensionResponseStatus;
    note?: string;
}
export declare class UpdateCustomOrderLifecycleStatusDto {
    status: CustomOrderStatus;
    note?: string;
}
export declare class QueryCustomOrdersDto {
    page?: number;
    limit?: number;
    status?: CustomOrderStatus;
    stage?: CustomOrderProgressStage;
    q?: string;
}
