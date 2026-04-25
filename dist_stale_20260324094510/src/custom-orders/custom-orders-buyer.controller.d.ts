import { Request } from 'express';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';
import { CustomOrdersService } from './custom-orders.service';
import { CancelCustomOrderDto, ConfirmCustomOrderDeliveryDto, CreateCustomOrderDto, CustomOrderPricePreviewDto, InitializeCustomOrderPaymentDto, QueryCustomOrdersDto, ReportCustomOrderIssueDto, RespondToCustomOrderExtensionDto, UpdateCustomOrderMeasurementsDto, UpdateDisplayChartPreferenceDto, VerifyCustomOrderPaymentDto } from './dto/custom-orders.dto';
export declare class CustomOrdersBuyerController {
    private readonly ordersService;
    private readonly paymentsService;
    constructor(ordersService: CustomOrdersService, paymentsService: CustomOrdersPaymentsService);
    pricePreview(req: Request & {
        user: {
            id: string;
        };
    }, dto: CustomOrderPricePreviewDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            checkoutIntentId: any;
            configurationId: string;
            configurationVersionId: string;
            currency: string;
            buyerPriceSummary: any;
            priceLockExpiresAt: any;
            quoteStatus: "MANUAL_QUOTE_REQUIRED";
            pricingChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            displayChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            resolverPolicy: import("./dto/custom-orders.dto").CustomOrderResolverPolicy;
            computedSize: any;
            chartVersionId: string;
            noDirectMatch: boolean;
            conversionGuidance: string;
        };
    } | {
        statusCode: number;
        message: string;
        data: {
            checkoutIntentId: string;
            configurationId: string;
            configurationVersionId: string;
            currency: string;
            buyerPriceSummary: import("../custom-order-pricing/custom-order-pricing.service").CustomOrderPriceSummary;
            priceLockExpiresAt: string;
            quoteStatus: "AUTO_PRICED";
            pricingChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            displayChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            resolverPolicy: import("./dto/custom-orders.dto").CustomOrderResolverPolicy;
            computedSize: any;
            chartVersionId: string;
            noDirectMatch: boolean;
            conversionGuidance: string;
        };
    }>;
    createOrder(req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateCustomOrderDto): Promise<{
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
    initializePayment(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: InitializeCustomOrderPaymentDto): Promise<{
        status: string;
        data: {
            paymentAttemptId: string;
            reference: string;
            gateway: string;
            status: string;
            channel: string;
            callbackUrl: string;
            authorizationUrl: string;
            bankAccount: Record<string, unknown>;
            nextAction: Record<string, unknown>;
        };
    }>;
    verifyPayment(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: VerifyCustomOrderPaymentDto): Promise<{
        status: string;
        data: {
            awaitingProviderConfirmation?: boolean;
            recoveryAction?: unknown;
            recoveryMessage?: unknown;
            success: boolean;
            status: string;
            paymentAttemptId: string;
            reference: string;
            amount: number;
            currency: string;
            paidAt: string;
            channel: string;
            failureMessage: string;
            customOrderId: string;
        };
    }>;
    listOrders(req: Request & {
        user: {
            id: string;
        };
    }, query: QueryCustomOrdersDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: {
                id: string;
                status: import("@prisma/client").$Enums.CustomOrderStatus;
                paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
                sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
                sourceId: string;
                sourceTitle: string;
                brand: {
                    name: string;
                };
                buyerPriceSummary: {
                    grandTotal: unknown;
                    currency: string;
                };
                currentProgressStage: import("@prisma/client").$Enums.CustomOrderProgressStage;
                createdAt: Date;
            }[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getDisplayChartPreference(req: Request & {
        user: {
            id: string;
        };
    }): Promise<{
        statusCode: number;
        message: string;
        data: {
            displayChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            updatedAtMs: number;
        };
    }>;
    updateDisplayChartPreference(req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateDisplayChartPreferenceDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            displayChartFamily: import("./dto/custom-orders.dto").CustomOrderChartFamily;
            updatedAtMs: number;
        };
    }>;
    getOrder(id: string, req: Request & {
        user: {
            id: string;
        };
    }): Promise<{
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
    cancelOrder(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: CancelCustomOrderDto): Promise<{
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
    confirmDelivery(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: ConfirmCustomOrderDeliveryDto): Promise<{
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
    reportIssue(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: ReportCustomOrderIssueDto): Promise<{
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
    updateMeasurements(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderMeasurementsDto): Promise<{
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
    respondToExtension(id: string, requestId: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: RespondToCustomOrderExtensionDto): Promise<{
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
}
