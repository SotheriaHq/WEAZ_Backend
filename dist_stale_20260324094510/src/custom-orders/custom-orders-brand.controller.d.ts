import { Request } from 'express';
import { CustomOrdersService } from './custom-orders.service';
import { AcceptCustomOrderDto, BrandRespondToCustomOrderExtensionCounterDto, CreateExceptionReviewRequestDto, CreateCustomOrderExtensionRequestDto, QueryCustomOrdersDto, RejectCustomOrderDto, UpdateCustomOrderLifecycleStatusDto, UpdateCustomOrderProgressStageDto } from './dto/custom-orders.dto';
export declare class CustomOrdersBrandController {
    private readonly service;
    constructor(service: CustomOrdersService);
    listOrders(brandId: string, req: Request & {
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
    getOrder(brandId: string, id: string, req: Request & {
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
    acceptOrder(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: AcceptCustomOrderDto): Promise<{
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
    rejectOrder(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: RejectCustomOrderDto): Promise<{
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
    updateProgressStage(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderProgressStageDto): Promise<{
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
    createExtensionRequest(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateCustomOrderExtensionRequestDto): Promise<{
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
    respondToBuyerCounter(brandId: string, id: string, requestId: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: BrandRespondToCustomOrderExtensionCounterDto): Promise<{
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
    updateLifecycleStatus(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderLifecycleStatusDto): Promise<{
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
    createExceptionReviewRequest(brandId: string, id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateExceptionReviewRequestDto): Promise<{
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
