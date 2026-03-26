import { Request } from 'express';
import { CustomOrderAdminService } from './custom-order-admin.service';
import { AdminCustomOrderReminderDto, CancelPaidCustomOrderDto, CreateAdminCustomFabricRuleBasisDto, EscalateCustomOrderRefundReviewDto, QueryAdminCustomFabricRuleBasesDto, FlagCustomOrderRiskDto, QueryAdminCustomOrdersDto, QueryCustomOrderDisputesDto, QueryCustomOrderExceptionReviewsDto, QueryCustomOrderLedgerAllocationsDto, ReleaseCustomOrderLedgerAllocationsDto, QueryCustomOrderRefundReviewsDto, QueryCustomOrderRiskDashboardDto, QueryStaleCustomOrdersDto, ReviewCustomFabricRuleBasisDto, UpdateCustomOrderRetentionHoldDto, DecideCustomOrderExceptionReviewDto, UpdateAdminCustomFabricRuleBasisDto, UpdateCustomOrderDisputeDto } from './dto/custom-order-admin.dto';
export declare class CustomOrderAdminController {
    private readonly service;
    constructor(service: CustomOrderAdminService);
    getPendingBases(): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        }[];
    }>;
    reviewBasis(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: ReviewCustomFabricRuleBasisDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        };
    }>;
    listBases(query: QueryAdminCustomFabricRuleBasesDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        }[];
    }>;
    createBasis(req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateAdminCustomFabricRuleBasisDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        };
    }>;
    updateBasis(id: string, dto: UpdateAdminCustomFabricRuleBasisDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        };
    }>;
    deleteBasis(id: string): Promise<{
        statusCode: number;
        message: string;
        data: {
            id: string;
        };
    }>;
    getSummary(): Promise<{
        statusCode: number;
        message: string;
        data: {
            totals: {
                activeOrders: number;
                staleOrders: number;
                openDisputes: number;
                refundInProgress: number;
                deliveredAwaitingConfirmation: number;
                acceptanceSlaRisk: number;
                acceptanceTimeouts: number;
            };
            brandRisk: {
                stale: number;
                disputes: number;
                rejections: number;
                brandId: string;
                brandName: string;
            }[];
        };
    }>;
    getRiskDashboard(query: QueryCustomOrderRiskDashboardDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            overview: {
                periodDays: number;
                ordersPlaced: number;
                rushOrders: number;
                brandRejections: number;
                disputesOpened: number;
                refundsInitiated: number;
                adminEscalations: number;
                currentStaleOrders: number;
                currentAcceptanceSlaRisk: number;
                currentAcceptanceTimeouts: number;
                rushOrdersWithExceptions: number;
            };
            brandRisk: {
                ordersPlaced: number;
                rushOrders: number;
                brandRejections: number;
                disputesOpened: number;
                refundsInitiated: number;
                adminEscalations: number;
                staleOrders: number;
                acceptanceSlaRisk: number;
                acceptanceTimeouts: number;
                rushOrdersWithExceptions: number;
                brandId: string;
                brandName: string;
                riskScore: number;
            }[];
        };
    }>;
    listRefundReviews(query: QueryCustomOrderRefundReviewsDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: {
                id: string;
                status: import("@prisma/client").$Enums.CustomOrderStatus;
                paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
                paymentReference: string;
                sourceTitle: string;
                sourceBrandName: string;
                createdAt: Date;
                updatedAt: Date;
                brand: {
                    id: string;
                    name: string;
                    ownerId: string;
                };
                disputeCount: number;
                issueCount: number;
                latestRefundTimelineEvent: {
                    id: string;
                    createdAt: Date;
                    actorId: string | null;
                    customOrderId: string;
                    payloadJson: import("@prisma/client/runtime/client").JsonValue | null;
                    actorType: import("@prisma/client").$Enums.CustomOrderActorType;
                    eventType: import("@prisma/client").$Enums.CustomOrderTimelineEventType;
                };
                latestPaymentAttempt: {
                    id: string;
                    reference: string;
                    status: string;
                    provider: string;
                    amount: number;
                    currency: string;
                    confirmedAt: Date;
                    lastVerifiedAt: Date;
                    failureMessage: string;
                    createdAt: Date;
                };
                latestRefundEvent: {
                    type: string;
                    source: string;
                    payload: import("@prisma/client/runtime/client").JsonValue;
                    createdAt: Date;
                };
            }[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getRefundReview(id: string): Promise<{
        statusCode: number;
        message: string;
        data: {
            order: {
                brand: {
                    id: string;
                    name: string;
                    ownerId: string;
                };
                progressEvents: {
                    id: string;
                    note: string | null;
                    customOrderId: string;
                    stage: import("@prisma/client").$Enums.CustomOrderProgressStage;
                    changedById: string;
                    changedAt: Date;
                    buyerNotifiedAt: Date | null;
                    staleThresholdAt: Date | null;
                    staleBuyerWarnedAt: Date | null;
                    adminEscalatedAt: Date | null;
                }[];
                extensionRequests: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    targetType: import("@prisma/client").$Enums.CustomOrderExtensionTargetType;
                    resolvedAt: Date | null;
                    reason: string;
                    customOrderId: string;
                    requestedByBrandId: string;
                    requestedExtraDays: number;
                    buyerResponseStatus: import("@prisma/client").$Enums.CustomOrderExtensionResponseStatus;
                    buyerCounterDays: number | null;
                }[];
                timelineEvents: {
                    id: string;
                    createdAt: Date;
                    actorId: string | null;
                    customOrderId: string;
                    payloadJson: import("@prisma/client/runtime/client").JsonValue | null;
                    actorType: import("@prisma/client").$Enums.CustomOrderActorType;
                    eventType: import("@prisma/client").$Enums.CustomOrderTimelineEventType;
                }[];
                issues: {
                    description: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    customOrderId: string;
                    issueType: import("@prisma/client").$Enums.CustomOrderIssueType;
                    evidenceJson: import("@prisma/client/runtime/client").JsonValue | null;
                    openedById: string;
                }[];
                disputes: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    status: import("@prisma/client").$Enums.CustomOrderDisputeStatus;
                    resolution: import("@prisma/client").$Enums.CustomOrderDisputeResolution | null;
                    adminNotes: string | null;
                    resolvedAt: Date | null;
                    assignedAdminId: string | null;
                    customOrderId: string;
                    openedById: string;
                    reasonType: import("@prisma/client").$Enums.CustomOrderIssueType;
                    buyerStatement: string | null;
                    brandResponse: string | null;
                    openedAt: Date;
                    brandRespondByAt: Date | null;
                }[];
                ledgerAllocations: ({
                    payout: {
                        id: string;
                        createdAt: Date;
                        status: import("@prisma/client").$Enums.PayoutStatus;
                        currency: string;
                        amount: import("@prisma/client-runtime-utils").Decimal;
                        reference: string;
                    };
                } & {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    status: import("@prisma/client").$Enums.CustomOrderLedgerAllocationStatus;
                    currency: string;
                    amount: import("@prisma/client-runtime-utils").Decimal;
                    commissionRate: import("@prisma/client-runtime-utils").Decimal;
                    commissionAmount: import("@prisma/client-runtime-utils").Decimal;
                    netBrandAmount: import("@prisma/client-runtime-utils").Decimal;
                    customOrderId: string;
                    payoutId: string | null;
                    allocationType: import("@prisma/client").$Enums.CustomOrderLedgerAllocationType;
                    eligibleAt: Date | null;
                    paidOutAt: Date | null;
                    reversedAt: Date | null;
                    reversalReason: string | null;
                })[];
            } & {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomOrderStatus;
                currency: string;
                brandId: string;
                buyerId: string;
                paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
                paymentMethod: import("@prisma/client").$Enums.PaymentMethod;
                paymentReference: string | null;
                deliveredAt: Date | null;
                sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
                sourceId: string;
                sourceTitleSnapshot: string;
                sourceSlugSnapshot: string | null;
                sourcePrimaryMediaUrlSnapshot: string | null;
                sourceBrandNameSnapshot: string | null;
                configurationId: string;
                configurationVersionId: string;
                idempotencyKey: string | null;
                checkoutIntentId: string | null;
                baseProductionChargeSnapshot: import("@prisma/client-runtime-utils").Decimal;
                fabricCostPerYardSnapshot: import("@prisma/client-runtime-utils").Decimal;
                computedYards: import("@prisma/client-runtime-utils").Decimal;
                matchedFabricRuleId: string | null;
                internalPriceBreakdownJson: import("@prisma/client/runtime/client").JsonValue;
                buyerPriceSummaryJson: import("@prisma/client/runtime/client").JsonValue;
                measurementSnapshotJson: import("@prisma/client/runtime/client").JsonValue;
                measurementConfirmedAt: Date;
                rushSelected: boolean;
                rushFeeSnapshot: import("@prisma/client-runtime-utils").Decimal | null;
                productionLeadDaysSnapshot: number;
                deliveryMinDaysSnapshot: number;
                deliveryMaxDaysSnapshot: number;
                shippingAddressJson: import("@prisma/client/runtime/client").JsonValue | null;
                contactInfoJson: import("@prisma/client/runtime/client").JsonValue | null;
                promisedProductionAt: Date | null;
                promisedDispatchAt: Date | null;
                promisedDeliveryAt: Date | null;
                currentProgressStage: import("@prisma/client").$Enums.CustomOrderProgressStage;
                currentProgressStageEnteredAt: Date;
                lastBrandProgressUpdateAt: Date | null;
                buyerAcceptanceWindowEndsAt: Date | null;
                acceptedAt: Date | null;
                rejectedAt: Date | null;
                buyerAcceptedAt: Date | null;
                issueReportedAt: Date | null;
                completedAt: Date | null;
                measurementRetentionUntil: Date | null;
                anonymizedAt: Date | null;
                retentionHoldType: import("@prisma/client").$Enums.CustomOrderRetentionHoldType | null;
                retentionHoldReason: string | null;
                retentionHoldUntil: Date | null;
                retentionHoldSetById: string | null;
                retentionHoldSetAt: Date | null;
            };
            paymentAttempts: {
                amount: number;
                id: string;
                createdAt: Date;
                status: string;
                currency: string;
                reference: string;
                provider: string;
                requestSnapshot: import("@prisma/client/runtime/client").JsonValue;
                responseSnapshot: import("@prisma/client/runtime/client").JsonValue;
                failureMessage: string;
                confirmedAt: Date;
                lastVerifiedAt: Date;
            }[];
            paymentEvents: {
                createdAt: Date;
                type: string;
                payload: import("@prisma/client/runtime/client").JsonValue;
                source: string;
                paymentAttemptId: string;
            }[];
        };
    }>;
    getStaleOrders(query: QueryStaleCustomOrdersDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: {
                id: string;
                stage: import("@prisma/client").$Enums.CustomOrderProgressStage;
                changedAt: Date;
                staleThresholdAt: Date;
                staleBuyerWarnedAt: Date;
                adminEscalatedAt: Date;
                customOrder: {
                    id: any;
                    brandId: any;
                    buyerId: any;
                    status: any;
                    paymentStatus: any;
                    currentProgressStage: any;
                    sourceTitle: any;
                    sourceBrandName: any;
                    lastBrandProgressUpdateAt: any;
                    buyerAcceptanceWindowEndsAt: any;
                    createdAt: any;
                    updatedAt: any;
                    brand: {
                        id: any;
                        name: any;
                        ownerId: any;
                    };
                };
            }[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    listOrders(query: QueryAdminCustomOrdersDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: {
                id: any;
                brandId: any;
                buyerId: any;
                status: any;
                paymentStatus: any;
                currentProgressStage: any;
                sourceTitle: any;
                sourceBrandName: any;
                lastBrandProgressUpdateAt: any;
                buyerAcceptanceWindowEndsAt: any;
                createdAt: any;
                updatedAt: any;
                brand: {
                    id: any;
                    name: any;
                    ownerId: any;
                };
            }[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    listExceptionReviews(query: QueryCustomOrderExceptionReviewsDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: {
                id: string;
                createdAt: Date;
                payload: import("@prisma/client/runtime/client").JsonValue;
                customOrder: {
                    id: string;
                    createdAt: Date;
                    status: import("@prisma/client").$Enums.CustomOrderStatus;
                    brandId: string;
                    sourceTitleSnapshot: string;
                    sourceBrandNameSnapshot: string;
                };
            }[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    decideExceptionReview(id: string, eventId: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: DecideCustomOrderExceptionReviewDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomOrderStatus;
            currency: string;
            brandId: string;
            buyerId: string;
            paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
            paymentMethod: import("@prisma/client").$Enums.PaymentMethod;
            paymentReference: string | null;
            deliveredAt: Date | null;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
            sourceTitleSnapshot: string;
            sourceSlugSnapshot: string | null;
            sourcePrimaryMediaUrlSnapshot: string | null;
            sourceBrandNameSnapshot: string | null;
            configurationId: string;
            configurationVersionId: string;
            idempotencyKey: string | null;
            checkoutIntentId: string | null;
            baseProductionChargeSnapshot: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYardSnapshot: import("@prisma/client-runtime-utils").Decimal;
            computedYards: import("@prisma/client-runtime-utils").Decimal;
            matchedFabricRuleId: string | null;
            internalPriceBreakdownJson: import("@prisma/client/runtime/client").JsonValue;
            buyerPriceSummaryJson: import("@prisma/client/runtime/client").JsonValue;
            measurementSnapshotJson: import("@prisma/client/runtime/client").JsonValue;
            measurementConfirmedAt: Date;
            rushSelected: boolean;
            rushFeeSnapshot: import("@prisma/client-runtime-utils").Decimal | null;
            productionLeadDaysSnapshot: number;
            deliveryMinDaysSnapshot: number;
            deliveryMaxDaysSnapshot: number;
            shippingAddressJson: import("@prisma/client/runtime/client").JsonValue | null;
            contactInfoJson: import("@prisma/client/runtime/client").JsonValue | null;
            promisedProductionAt: Date | null;
            promisedDispatchAt: Date | null;
            promisedDeliveryAt: Date | null;
            currentProgressStage: import("@prisma/client").$Enums.CustomOrderProgressStage;
            currentProgressStageEnteredAt: Date;
            lastBrandProgressUpdateAt: Date | null;
            buyerAcceptanceWindowEndsAt: Date | null;
            acceptedAt: Date | null;
            rejectedAt: Date | null;
            buyerAcceptedAt: Date | null;
            issueReportedAt: Date | null;
            completedAt: Date | null;
            measurementRetentionUntil: Date | null;
            anonymizedAt: Date | null;
            retentionHoldType: import("@prisma/client").$Enums.CustomOrderRetentionHoldType | null;
            retentionHoldReason: string | null;
            retentionHoldUntil: Date | null;
            retentionHoldSetById: string | null;
            retentionHoldSetAt: Date | null;
        };
    }>;
    getOrder(id: string): Promise<{
        statusCode: number;
        message: string;
        data: {
            brand: {
                id: string;
                name: string;
                ownerId: string;
            };
            progressEvents: {
                id: string;
                note: string | null;
                customOrderId: string;
                stage: import("@prisma/client").$Enums.CustomOrderProgressStage;
                changedById: string;
                changedAt: Date;
                buyerNotifiedAt: Date | null;
                staleThresholdAt: Date | null;
                staleBuyerWarnedAt: Date | null;
                adminEscalatedAt: Date | null;
            }[];
            extensionRequests: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                targetType: import("@prisma/client").$Enums.CustomOrderExtensionTargetType;
                resolvedAt: Date | null;
                reason: string;
                customOrderId: string;
                requestedByBrandId: string;
                requestedExtraDays: number;
                buyerResponseStatus: import("@prisma/client").$Enums.CustomOrderExtensionResponseStatus;
                buyerCounterDays: number | null;
            }[];
            timelineEvents: {
                id: string;
                createdAt: Date;
                actorId: string | null;
                customOrderId: string;
                payloadJson: import("@prisma/client/runtime/client").JsonValue | null;
                actorType: import("@prisma/client").$Enums.CustomOrderActorType;
                eventType: import("@prisma/client").$Enums.CustomOrderTimelineEventType;
            }[];
            issues: {
                description: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                customOrderId: string;
                issueType: import("@prisma/client").$Enums.CustomOrderIssueType;
                evidenceJson: import("@prisma/client/runtime/client").JsonValue | null;
                openedById: string;
            }[];
            disputes: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomOrderDisputeStatus;
                resolution: import("@prisma/client").$Enums.CustomOrderDisputeResolution | null;
                adminNotes: string | null;
                resolvedAt: Date | null;
                assignedAdminId: string | null;
                customOrderId: string;
                openedById: string;
                reasonType: import("@prisma/client").$Enums.CustomOrderIssueType;
                buyerStatement: string | null;
                brandResponse: string | null;
                openedAt: Date;
                brandRespondByAt: Date | null;
            }[];
            ledgerAllocations: ({
                payout: {
                    id: string;
                    createdAt: Date;
                    status: import("@prisma/client").$Enums.PayoutStatus;
                    currency: string;
                    amount: import("@prisma/client-runtime-utils").Decimal;
                    reference: string;
                };
            } & {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomOrderLedgerAllocationStatus;
                currency: string;
                amount: import("@prisma/client-runtime-utils").Decimal;
                commissionRate: import("@prisma/client-runtime-utils").Decimal;
                commissionAmount: import("@prisma/client-runtime-utils").Decimal;
                netBrandAmount: import("@prisma/client-runtime-utils").Decimal;
                customOrderId: string;
                payoutId: string | null;
                allocationType: import("@prisma/client").$Enums.CustomOrderLedgerAllocationType;
                eligibleAt: Date | null;
                paidOutAt: Date | null;
                reversedAt: Date | null;
                reversalReason: string | null;
            })[];
        } & {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomOrderStatus;
            currency: string;
            brandId: string;
            buyerId: string;
            paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
            paymentMethod: import("@prisma/client").$Enums.PaymentMethod;
            paymentReference: string | null;
            deliveredAt: Date | null;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
            sourceTitleSnapshot: string;
            sourceSlugSnapshot: string | null;
            sourcePrimaryMediaUrlSnapshot: string | null;
            sourceBrandNameSnapshot: string | null;
            configurationId: string;
            configurationVersionId: string;
            idempotencyKey: string | null;
            checkoutIntentId: string | null;
            baseProductionChargeSnapshot: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYardSnapshot: import("@prisma/client-runtime-utils").Decimal;
            computedYards: import("@prisma/client-runtime-utils").Decimal;
            matchedFabricRuleId: string | null;
            internalPriceBreakdownJson: import("@prisma/client/runtime/client").JsonValue;
            buyerPriceSummaryJson: import("@prisma/client/runtime/client").JsonValue;
            measurementSnapshotJson: import("@prisma/client/runtime/client").JsonValue;
            measurementConfirmedAt: Date;
            rushSelected: boolean;
            rushFeeSnapshot: import("@prisma/client-runtime-utils").Decimal | null;
            productionLeadDaysSnapshot: number;
            deliveryMinDaysSnapshot: number;
            deliveryMaxDaysSnapshot: number;
            shippingAddressJson: import("@prisma/client/runtime/client").JsonValue | null;
            contactInfoJson: import("@prisma/client/runtime/client").JsonValue | null;
            promisedProductionAt: Date | null;
            promisedDispatchAt: Date | null;
            promisedDeliveryAt: Date | null;
            currentProgressStage: import("@prisma/client").$Enums.CustomOrderProgressStage;
            currentProgressStageEnteredAt: Date;
            lastBrandProgressUpdateAt: Date | null;
            buyerAcceptanceWindowEndsAt: Date | null;
            acceptedAt: Date | null;
            rejectedAt: Date | null;
            buyerAcceptedAt: Date | null;
            issueReportedAt: Date | null;
            completedAt: Date | null;
            measurementRetentionUntil: Date | null;
            anonymizedAt: Date | null;
            retentionHoldType: import("@prisma/client").$Enums.CustomOrderRetentionHoldType | null;
            retentionHoldReason: string | null;
            retentionHoldUntil: Date | null;
            retentionHoldSetById: string | null;
            retentionHoldSetAt: Date | null;
        };
    }>;
    remindBrand(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: AdminCustomOrderReminderDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            customOrderId: string;
            brandId: string;
        };
    }>;
    flagRisk(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: FlagCustomOrderRiskDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            customOrderId: string;
            brandId: string;
            reason: string;
        };
    }>;
    escalateRefundReview(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: EscalateCustomOrderRefundReviewDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            customOrderId: string;
            status: import("@prisma/client").$Enums.CustomOrderStatus;
        };
    }>;
    cancelPaidOrder(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: CancelPaidCustomOrderDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            customOrderId: string;
            status: import("@prisma/client").$Enums.CustomOrderStatus;
            paymentStatus: import("@prisma/client").$Enums.PaymentStatus;
        };
    }>;
    listDisputes(query: QueryCustomOrderDisputesDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: ({
                customOrder: {
                    id: string;
                    status: import("@prisma/client").$Enums.CustomOrderStatus;
                    brandId: string;
                    buyerId: string;
                    sourceTitleSnapshot: string;
                    sourceBrandNameSnapshot: string;
                };
            } & {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomOrderDisputeStatus;
                resolution: import("@prisma/client").$Enums.CustomOrderDisputeResolution | null;
                adminNotes: string | null;
                resolvedAt: Date | null;
                assignedAdminId: string | null;
                customOrderId: string;
                openedById: string;
                reasonType: import("@prisma/client").$Enums.CustomOrderIssueType;
                buyerStatement: string | null;
                brandResponse: string | null;
                openedAt: Date;
                brandRespondByAt: Date | null;
            })[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    listLedgerAllocations(query: QueryCustomOrderLedgerAllocationsDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: ({
                customOrder: {
                    id: string;
                    status: import("@prisma/client").$Enums.CustomOrderStatus;
                    brandId: string;
                    buyerId: string;
                    sourceTitleSnapshot: string;
                    sourceBrandNameSnapshot: string;
                };
                payout: {
                    id: string;
                    createdAt: Date;
                    status: import("@prisma/client").$Enums.PayoutStatus;
                    currency: string;
                    amount: import("@prisma/client-runtime-utils").Decimal;
                    reference: string;
                };
            } & {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomOrderLedgerAllocationStatus;
                currency: string;
                amount: import("@prisma/client-runtime-utils").Decimal;
                commissionRate: import("@prisma/client-runtime-utils").Decimal;
                commissionAmount: import("@prisma/client-runtime-utils").Decimal;
                netBrandAmount: import("@prisma/client-runtime-utils").Decimal;
                customOrderId: string;
                payoutId: string | null;
                allocationType: import("@prisma/client").$Enums.CustomOrderLedgerAllocationType;
                eligibleAt: Date | null;
                paidOutAt: Date | null;
                reversedAt: Date | null;
                reversalReason: string | null;
            })[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    releaseLedgerAllocations(req: Request & {
        user: {
            id: string;
        };
    }, dto: ReleaseCustomOrderLedgerAllocationsDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            dryRun: boolean;
            releasedBatches: number;
            releasedAllocations: number;
            releasedTotalAmount: number;
        };
    }>;
    updateDispute(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderDisputeDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomOrderDisputeStatus;
            resolution: import("@prisma/client").$Enums.CustomOrderDisputeResolution | null;
            adminNotes: string | null;
            resolvedAt: Date | null;
            assignedAdminId: string | null;
            customOrderId: string;
            openedById: string;
            reasonType: import("@prisma/client").$Enums.CustomOrderIssueType;
            buyerStatement: string | null;
            brandResponse: string | null;
            openedAt: Date;
            brandRespondByAt: Date | null;
        };
    }>;
    updateRetentionHold(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderRetentionHoldDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            id: string;
            retentionHoldType: import("@prisma/client").$Enums.CustomOrderRetentionHoldType;
            retentionHoldReason: string;
            retentionHoldUntil: Date;
            retentionHoldSetById: string;
            retentionHoldSetAt: Date;
        };
    }>;
}
