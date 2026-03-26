"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrdersService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../prisma/prisma.service");
const custom_order_pricing_service_1 = require("../custom-order-pricing/custom-order-pricing.service");
const ledger_service_1 = require("../finance/ledger.service");
const custom_order_refund_service_1 = require("./custom-order-refund.service");
const custom_order_side_effects_service_1 = require("./custom-order-side-effects.service");
const BUYER_ACCEPTANCE_WINDOW_HOURS = 72;
const EXCEPTION_REVIEW_MONTHLY_QUOTA = 2;
const EXCEPTION_REVIEW_SLA_HOURS = 24;
const DEFAULT_PRICING_CHART_FAMILY = 'HYBRID_UK_NIGERIA';
const DEFAULT_DISPLAY_CHART_FAMILY = 'UK';
const DEFAULT_RESOLVER_POLICY = 'MAX_OF_BOTH';
const CHART_BANDS = {
    UK: [
        { label: 'UK 8', bustMin: 80, bustMax: 84, waistMin: 62, waistMax: 66, hipsMin: 88, hipsMax: 92 },
        { label: 'UK 10', bustMin: 84, bustMax: 88, waistMin: 66, waistMax: 70, hipsMin: 92, hipsMax: 96 },
        { label: 'UK 12', bustMin: 88, bustMax: 92, waistMin: 70, waistMax: 74, hipsMin: 96, hipsMax: 100 },
        { label: 'UK 14', bustMin: 92, bustMax: 98, waistMin: 74, waistMax: 80, hipsMin: 100, hipsMax: 106 },
        { label: 'UK 16', bustMin: 98, bustMax: 104, waistMin: 80, waistMax: 86, hipsMin: 106, hipsMax: 112 },
        { label: 'UK 18', bustMin: 104, bustMax: 112, waistMin: 86, waistMax: 94, hipsMin: 112, hipsMax: 120 },
    ],
    US: [
        { label: 'US 4', bustMin: 80, bustMax: 84, waistMin: 62, waistMax: 66, hipsMin: 88, hipsMax: 92 },
        { label: 'US 6', bustMin: 84, bustMax: 88, waistMin: 66, waistMax: 70, hipsMin: 92, hipsMax: 96 },
        { label: 'US 8', bustMin: 88, bustMax: 92, waistMin: 70, waistMax: 74, hipsMin: 96, hipsMax: 100 },
        { label: 'US 10', bustMin: 92, bustMax: 98, waistMin: 74, waistMax: 80, hipsMin: 100, hipsMax: 106 },
        { label: 'US 12', bustMin: 98, bustMax: 104, waistMin: 80, waistMax: 86, hipsMin: 106, hipsMax: 112 },
        { label: 'US 14', bustMin: 104, bustMax: 112, waistMin: 86, waistMax: 94, hipsMin: 112, hipsMax: 120 },
    ],
    NIGERIA: [
        { label: 'NG 8', bustMin: 80, bustMax: 85, waistMin: 62, waistMax: 67, hipsMin: 88, hipsMax: 93 },
        { label: 'NG 10', bustMin: 85, bustMax: 90, waistMin: 67, waistMax: 72, hipsMin: 93, hipsMax: 98 },
        { label: 'NG 12', bustMin: 90, bustMax: 96, waistMin: 72, waistMax: 78, hipsMin: 98, hipsMax: 104 },
        { label: 'NG 14', bustMin: 96, bustMax: 102, waistMin: 78, waistMax: 84, hipsMin: 104, hipsMax: 110 },
        { label: 'NG 16', bustMin: 102, bustMax: 110, waistMin: 84, waistMax: 92, hipsMin: 110, hipsMax: 118 },
        { label: 'NG 18', bustMin: 110, bustMax: 120, waistMin: 92, waistMax: 102, hipsMin: 118, hipsMax: 128 },
    ],
    ASIA: [
        { label: 'ASIA M', bustMin: 78, bustMax: 84, waistMin: 60, waistMax: 66, hipsMin: 84, hipsMax: 92 },
        { label: 'ASIA L', bustMin: 84, bustMax: 90, waistMin: 66, waistMax: 72, hipsMin: 92, hipsMax: 98 },
        { label: 'ASIA XL', bustMin: 90, bustMax: 96, waistMin: 72, waistMax: 78, hipsMin: 98, hipsMax: 104 },
        { label: 'ASIA XXL', bustMin: 96, bustMax: 102, waistMin: 78, waistMax: 84, hipsMin: 104, hipsMax: 110 },
        { label: 'ASIA 3XL', bustMin: 102, bustMax: 110, waistMin: 84, waistMax: 92, hipsMin: 110, hipsMax: 118 },
        { label: 'ASIA 4XL', bustMin: 110, bustMax: 120, waistMin: 92, waistMax: 102, hipsMin: 118, hipsMax: 128 },
    ],
};
const BASELINE_KEY_CANDIDATES = {
    MEN: [
        'MEN_HEIGHT',
        'MEN_WEIGHT',
        'MEN_SHOULDER',
        'MEN_CHEST',
        'MEN_WAIST',
        'MEN_HIP',
        'MEN_INSEAM',
        'MEN_SLEEVE_LENGTH',
    ],
    WOMEN: [
        'WOMEN_HEIGHT',
        'WOMEN_WEIGHT',
        'WOMEN_SHOULDER_WIDTH',
        'WOMEN_CHEST_FULL_BUST',
        'WOMEN_WAIST',
        'WOMEN_HIP',
        'WOMEN_INSEAM',
        'WOMEN_SLEEVE_LENGTH_LONG',
    ],
};
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`;
    const objectValue = value;
    const keys = Object.keys(objectValue).sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
        .join(',')}}`;
}
let CustomOrdersService = class CustomOrdersService {
    constructor(prisma, pricingService, sideEffects, refundService, ledgerService) {
        this.prisma = prisma;
        this.pricingService = pricingService;
        this.sideEffects = sideEffects;
        this.refundService = refundService;
        this.ledgerService = ledgerService;
    }
    async createPricePreview(userId, dto) {
        const configuration = await this.getActiveConfiguration(dto.configurationId, dto.configurationVersionId);
        const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(configuration.requiredMeasurementKeys, configuration.requiredFreeformPointIds, dto.measurementValues);
        await this.validateMeasurementRanges(requiredMeasurementKeys, dto.measurementValues);
        const chartEvaluation = this.resolveChartEvaluation({
            measurementValues: dto.measurementValues,
            pricingChartFamily: dto.pricingChartFamily ?? DEFAULT_PRICING_CHART_FAMILY,
            displayChartFamily: dto.displayChartFamily ?? DEFAULT_DISPLAY_CHART_FAMILY,
            resolverPolicy: dto.resolverPolicy ?? DEFAULT_RESOLVER_POLICY,
        });
        const yardProfile = this.parseConfigurationYardProfile(configuration.notes);
        if (chartEvaluation.manualQuoteRequired) {
            return {
                statusCode: 200,
                message: 'Manual quote required for this measurement profile',
                data: {
                    checkoutIntentId: null,
                    configurationId: configuration.id,
                    configurationVersionId: configuration.version.id,
                    currency: configuration.brand.currency,
                    buyerPriceSummary: null,
                    priceLockExpiresAt: null,
                    quoteStatus: 'MANUAL_QUOTE_REQUIRED',
                    pricingChartFamily: chartEvaluation.pricingChartFamily,
                    displayChartFamily: chartEvaluation.displayChartFamily,
                    resolverPolicy: chartEvaluation.resolverPolicy,
                    computedSize: null,
                    chartVersionId: chartEvaluation.chartVersionId,
                    noDirectMatch: chartEvaluation.noDirectMatch,
                    conversionGuidance: chartEvaluation.conversionGuidance,
                },
            };
        }
        const preview = this.pricingService.buildPricePreview({
            baseProductionCharge: String(configuration.baseProductionCharge),
            fabricCostPerYard: String(configuration.fabricCostPerYard),
            rushEnabled: configuration.rushEnabled,
            rushFee: configuration.rushFee ? String(configuration.rushFee) : undefined,
            baseYardsOverride: yardProfile?.averageBaseYards,
            additionalYards: this.resolveAdditionalYardsFromProfile(yardProfile, chartEvaluation.computedSize),
            rules: this.pricingService.validateConfigurationRules(configuration.rules.map((rule) => ({
                priority: rule.priority,
                outputYards: String(rule.outputYards),
                isFallback: rule.isFallback,
                conditionsJson: rule.conditionsJson,
            }))),
            requiredMeasurementKeys,
            measurementValues: dto.measurementValues,
            rushSelected: dto.rushSelected,
            shippingAddress: dto.shippingAddress,
            currency: configuration.brand.currency,
        });
        const matchedRuleRecord = configuration.rules.find((rule) => rule.priority === preview.matchedRule.priority &&
            rule.isFallback === preview.matchedRule.isFallback);
        const requestSnapshot = this.buildCheckoutIntentRequestSnapshot(dto.measurementValues, dto.rushSelected, dto.shippingAddress, matchedRuleRecord?.id ?? null, chartEvaluation);
        const previewHash = (0, crypto_1.createHash)('sha256')
            .update(stableStringify({ userId, configurationId: configuration.id, configurationVersionId: configuration.version.id, requestSnapshot }))
            .digest('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const existing = await this.prisma.customOrderCheckoutIntent.findUnique({
            where: { previewHash },
        });
        const checkoutIntent = existing && existing.expiresAt > new Date() && !existing.consumedAt
            ? existing
            : await this.prisma.customOrderCheckoutIntent.upsert({
                where: { previewHash },
                update: {
                    requestSnapshotJson: requestSnapshot,
                    buyerPriceSummaryJson: preview.buyerPriceSummary,
                    expiresAt,
                    consumedAt: null,
                },
                create: {
                    buyerId: userId,
                    configurationId: configuration.id,
                    configurationVersionId: configuration.version.id,
                    previewHash,
                    requestSnapshotJson: requestSnapshot,
                    buyerPriceSummaryJson: preview.buyerPriceSummary,
                    expiresAt,
                },
            });
        return {
            statusCode: 200,
            message: 'Custom order price preview created',
            data: {
                checkoutIntentId: checkoutIntent.id,
                configurationId: configuration.id,
                configurationVersionId: configuration.version.id,
                currency: configuration.brand.currency,
                buyerPriceSummary: preview.buyerPriceSummary,
                priceLockExpiresAt: checkoutIntent.expiresAt.toISOString(),
                quoteStatus: 'AUTO_PRICED',
                pricingChartFamily: chartEvaluation.pricingChartFamily,
                displayChartFamily: chartEvaluation.displayChartFamily,
                resolverPolicy: chartEvaluation.resolverPolicy,
                computedSize: chartEvaluation.computedSize,
                chartVersionId: chartEvaluation.chartVersionId,
                noDirectMatch: chartEvaluation.noDirectMatch,
                conversionGuidance: chartEvaluation.conversionGuidance,
            },
        };
    }
    async createOrder(userId, dto) {
        const existing = await this.prisma.customOrder.findFirst({
            where: {
                buyerId: userId,
                idempotencyKey: dto.idempotencyKey,
            },
            include: {
                progressEvents: { orderBy: { changedAt: 'asc' } },
                extensionRequests: { orderBy: { createdAt: 'desc' } },
                timelineEvents: { orderBy: { createdAt: 'asc' } },
                issues: { orderBy: { createdAt: 'desc' } },
                disputes: { orderBy: { openedAt: 'desc' } },
            },
        });
        if (existing) {
            return {
                statusCode: 200,
                message: 'Custom order already exists for the supplied idempotency key',
                data: this.mapDetail(existing),
            };
        }
        const intent = await this.prisma.customOrderCheckoutIntent.findFirst({
            where: { id: dto.checkoutIntentId, buyerId: userId },
        });
        if (!intent) {
            throw new common_1.NotFoundException('Custom order checkout intent not found');
        }
        if (intent.expiresAt <= new Date()) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_CHECKOUT_INTENT_EXPIRED');
        }
        if (intent.consumedAt) {
            throw new common_1.BadRequestException('Checkout intent has already been consumed');
        }
        if (intent.configurationId !== dto.configurationId) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_CONFIGURATION_VERSION_MISMATCH');
        }
        if (dto.configurationVersionId && intent.configurationVersionId !== dto.configurationVersionId) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_CONFIGURATION_VERSION_MISMATCH');
        }
        const intentSnapshot = this.normalizeCheckoutIntentRequestSnapshot(intent.requestSnapshotJson);
        const submittedSnapshot = this.buildCheckoutIntentRequestSnapshot(dto.measurementValues, dto.rushSelected, dto.shippingAddress, intentSnapshot.matchedFabricRuleId, intentSnapshot.chartLock);
        if (stableStringify(intentSnapshot) !== stableStringify(submittedSnapshot)) {
            throw new common_1.BadRequestException('Checkout intent payload does not match current order request');
        }
        if (intentSnapshot.chartLock.quoteStatus === 'MANUAL_QUOTE_REQUIRED') {
            throw new common_1.BadRequestException('MANUAL_QUOTE_REQUIRED');
        }
        if (intentSnapshot.chartLock.noDirectMatch && !dto.noDirectMatchAcknowledged) {
            throw new common_1.BadRequestException('NO_DIRECT_MATCH_ACK_REQUIRED');
        }
        const configuration = await this.getConfigurationVersion(intent.configurationId, intent.configurationVersionId);
        const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(configuration.snapshot.requiredMeasurementKeys ?? [], configuration.snapshot.requiredFreeformPointIds ?? [], dto.measurementValues);
        await this.validateMeasurementRanges(requiredMeasurementKeys, dto.measurementValues);
        const snapshotYardProfile = this.parseConfigurationYardProfile(typeof configuration.snapshot.notes === 'string' ? configuration.snapshot.notes : null);
        const pricePreview = this.pricingService.buildPricePreview({
            baseProductionCharge: configuration.snapshot.baseProductionCharge,
            fabricCostPerYard: configuration.snapshot.fabricCostPerYard,
            rushEnabled: configuration.snapshot.rushEnabled,
            rushFee: configuration.snapshot.rushFee,
            baseYardsOverride: snapshotYardProfile?.averageBaseYards,
            additionalYards: this.resolveAdditionalYardsFromProfile(snapshotYardProfile, intentSnapshot.chartLock.computedSize),
            rules: this.pricingService.validateConfigurationRules((configuration.snapshot.rules ?? []).map((rule) => ({
                priority: Number(rule.priority),
                outputYards: String(rule.outputYards),
                isFallback: Boolean(rule.isFallback),
                conditionsJson: this.conditionsFromSnapshot(rule.conditions),
            }))),
            requiredMeasurementKeys,
            measurementValues: dto.measurementValues,
            rushSelected: dto.rushSelected,
            shippingAddress: dto.shippingAddress,
            currency: configuration.configuration.brand.currency,
        });
        const requiredMeasurementSnapshot = requiredMeasurementKeys.reduce((accumulator, key) => {
            const value = Number(dto.measurementValues[key]);
            if (Number.isFinite(value)) {
                accumulator[key] = value;
            }
            return accumulator;
        }, {});
        const sourceSnapshot = await this.resolveSourceSnapshot(configuration.configuration.sourceType, configuration.configuration.sourceId);
        const retainedUntil = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
        try {
            const order = await this.prisma.$transaction(async (tx) => {
                const consumedAt = new Date();
                const intentClaim = await tx.customOrderCheckoutIntent.updateMany({
                    where: {
                        id: intent.id,
                        buyerId: userId,
                        consumedAt: null,
                        expiresAt: { gt: consumedAt },
                    },
                    data: { consumedAt },
                });
                if (intentClaim.count === 0) {
                    throw new common_1.BadRequestException('CUSTOM_ORDER_CHECKOUT_INTENT_ALREADY_CONSUMED');
                }
                return tx.customOrder.create({
                    data: {
                        brandId: configuration.configuration.brandId,
                        buyerId: userId,
                        sourceType: configuration.configuration.sourceType,
                        sourceId: configuration.configuration.sourceId,
                        sourceTitleSnapshot: sourceSnapshot.title,
                        sourceSlugSnapshot: sourceSnapshot.slug,
                        sourcePrimaryMediaUrlSnapshot: sourceSnapshot.primaryMediaUrl,
                        sourceBrandNameSnapshot: sourceSnapshot.brandName,
                        configurationId: configuration.configuration.id,
                        configurationVersionId: configuration.version.id,
                        status: client_1.CustomOrderStatus.DRAFT,
                        paymentStatus: 'PENDING',
                        currency: configuration.configuration.brand.currency,
                        checkoutIntentId: intent.id,
                        baseProductionChargeSnapshot: new client_1.Prisma.Decimal(configuration.snapshot.baseProductionCharge),
                        fabricCostPerYardSnapshot: new client_1.Prisma.Decimal(configuration.snapshot.fabricCostPerYard),
                        computedYards: new client_1.Prisma.Decimal(pricePreview.computedYards),
                        matchedFabricRuleId: typeof intentSnapshot.matchedFabricRuleId === 'string'
                            ? intentSnapshot.matchedFabricRuleId
                            : null,
                        internalPriceBreakdownJson: {
                            ...pricePreview.internalPriceBreakdown,
                            chartLock: intentSnapshot.chartLock,
                            noDirectMatchAcknowledged: Boolean(dto.noDirectMatchAcknowledged),
                            requiredMeasurementSnapshot,
                            measurementAttachmentMeta: {
                                attachedAt: new Date().toISOString(),
                                requiredMeasurementKeys,
                                requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
                            },
                        },
                        buyerPriceSummaryJson: intent.buyerPriceSummaryJson,
                        measurementSnapshotJson: dto.measurementValues,
                        measurementConfirmedAt: new Date(),
                        rushSelected: dto.rushSelected,
                        rushFeeSnapshot: configuration.snapshot.rushFee
                            ? new client_1.Prisma.Decimal(configuration.snapshot.rushFee)
                            : null,
                        productionLeadDaysSnapshot: configuration.snapshot.productionLeadDays,
                        deliveryMinDaysSnapshot: configuration.snapshot.deliveryMinDays,
                        deliveryMaxDaysSnapshot: configuration.snapshot.deliveryMaxDays,
                        shippingAddressJson: dto.shippingAddress,
                        contactInfoJson: {
                            ...dto.contactInfo,
                            customerName: dto.customerName,
                        },
                        idempotencyKey: dto.idempotencyKey,
                        measurementRetentionUntil: retainedUntil,
                        timelineEvents: {
                            create: [
                                {
                                    actorType: client_1.CustomOrderActorType.SYSTEM,
                                    eventType: 'CONFIGURATION_VERSION_LOCKED',
                                    payloadJson: {
                                        configurationId: configuration.configuration.id,
                                        configurationVersionId: configuration.version.id,
                                        checkoutIntentId: intent.id,
                                        chartVersionId: intentSnapshot.chartLock.chartVersionId,
                                        pricingChartFamily: intentSnapshot.chartLock.pricingChartFamily,
                                        displayChartFamily: intentSnapshot.chartLock.displayChartFamily,
                                        resolverPolicy: intentSnapshot.chartLock.resolverPolicy,
                                        computedSize: intentSnapshot.chartLock.computedSize,
                                        noDirectMatch: intentSnapshot.chartLock.noDirectMatch,
                                    },
                                },
                                {
                                    actorType: client_1.CustomOrderActorType.BUYER,
                                    actorId: userId,
                                    eventType: 'ORDER_CREATED',
                                    payloadJson: {
                                        checkoutIntentId: intent.id,
                                        customerName: dto.customerName,
                                        requiredMeasurementKeys,
                                        requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
                                    },
                                },
                            ],
                        },
                        progressEvents: {
                            create: [
                                {
                                    stage: client_1.CustomOrderProgressStage.ORDER_PLACED,
                                    changedById: userId,
                                    staleThresholdAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                                },
                            ],
                        },
                    },
                    include: {
                        progressEvents: { orderBy: { changedAt: 'asc' } },
                        extensionRequests: { orderBy: { createdAt: 'desc' } },
                        timelineEvents: { orderBy: { createdAt: 'asc' } },
                        issues: { orderBy: { createdAt: 'desc' } },
                        disputes: { orderBy: { openedAt: 'desc' } },
                    },
                });
            });
            return {
                statusCode: 201,
                message: 'Custom order created',
                data: this.mapDetail(order),
            };
        }
        catch (error) {
            if (error instanceof client_1.Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002') {
                const duplicate = await this.prisma.customOrder.findFirst({
                    where: {
                        buyerId: userId,
                        idempotencyKey: dto.idempotencyKey,
                    },
                    include: this.detailIncludes,
                });
                if (duplicate) {
                    return {
                        statusCode: 200,
                        message: 'Custom order already exists for the supplied idempotency key',
                        data: this.mapDetail(duplicate),
                    };
                }
            }
            throw error;
        }
    }
    async listBuyerOrders(userId, query) {
        return this.listOrders({ buyerId: userId }, query);
    }
    async getBuyerOrder(userId, customOrderId) {
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, buyerId: userId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        return {
            statusCode: 200,
            message: 'Custom order retrieved',
            data: this.mapDetail(order),
        };
    }
    async cancelBuyerOrder(userId, customOrderId, dto) {
        const order = await this.requireBuyerOrder(userId, customOrderId);
        if (![
            client_1.CustomOrderStatus.DRAFT,
            client_1.CustomOrderStatus.PENDING_PAYMENT,
            client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
        ].includes(order.status)) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE');
        }
        const cancellationWindowMs = Math.max(0, parseInt(process.env.CUSTOM_ORDER_CANCEL_WINDOW_MS || '', 10) || 30 * 60 * 1000);
        if (order.status === client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE &&
            order.createdAt &&
            Date.now() - new Date(order.createdAt).getTime() > cancellationWindowMs) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_CANCELLATION_WINDOW_EXPIRED: You can only cancel within 30 minutes of placing the order');
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const paidPreAcceptance = order.paymentStatus === client_1.PaymentStatus.PAID;
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    status: client_1.CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
                    timelineEvents: {
                        create: paidPreAcceptance
                            ? [
                                {
                                    actorType: client_1.CustomOrderActorType.BUYER,
                                    actorId: userId,
                                    eventType: client_1.CustomOrderTimelineEventType.BUYER_CANCELLED,
                                    payloadJson: { reason: dto.reason, cancellationType: 'BUYER_PRE_ACCEPTANCE' },
                                },
                                {
                                    actorType: client_1.CustomOrderActorType.SYSTEM,
                                    eventType: 'REFUND_INITIATED',
                                    payloadJson: {
                                        reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
                                    },
                                },
                            ]
                            : {
                                actorType: client_1.CustomOrderActorType.BUYER,
                                actorId: userId,
                                eventType: client_1.CustomOrderTimelineEventType.BUYER_CANCELLED,
                                payloadJson: { reason: dto.reason, cancellationType: 'BUYER_PRE_ACCEPTANCE' },
                            },
                    },
                },
                include: this.detailIncludes,
            });
            if (paidPreAcceptance) {
                await tx.customOrderLedgerAllocation.updateMany({
                    where: { customOrderId },
                    data: {
                        status: client_1.CustomOrderLedgerAllocationStatus.REVERSED,
                        reversedAt: new Date(),
                        reversalReason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
                    },
                });
                await this.refundService.initiateRefund(tx, {
                    customOrderId,
                    reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
                    actorType: client_1.CustomOrderActorType.BUYER,
                    actorId: userId,
                });
            }
            return next;
        });
        return {
            statusCode: 200,
            message: 'Custom order cancelled',
            data: this.mapDetail(updated),
        };
    }
    async confirmDelivery(userId, customOrderId, dto) {
        const order = await this.requireBuyerOrder(userId, customOrderId);
        if (order.status !== client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE');
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const confirmedAt = new Date();
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    status: client_1.CustomOrderStatus.COMPLETED,
                    buyerAcceptedAt: confirmedAt,
                    completedAt: confirmedAt,
                    timelineEvents: {
                        create: {
                            actorType: client_1.CustomOrderActorType.BUYER,
                            actorId: userId,
                            eventType: 'BUYER_CONFIRMED_DELIVERY',
                            payloadJson: dto.note ? { note: dto.note } : client_1.Prisma.JsonNull,
                        },
                    },
                },
                include: this.detailIncludes,
            });
            await tx.customOrderLedgerAllocation.updateMany({
                where: {
                    customOrderId,
                    allocationType: client_1.CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
                    status: client_1.CustomOrderLedgerAllocationStatus.HELD,
                },
                data: {
                    status: client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                    eligibleAt: confirmedAt,
                },
            });
            const finalAllocation = await tx.customOrderLedgerAllocation.findFirst({
                where: {
                    customOrderId,
                    allocationType: client_1.CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
                },
                select: {
                    amount: true,
                    commissionAmount: true,
                    netBrandAmount: true,
                    currency: true,
                },
            });
            if (finalAllocation) {
                await this.ledgerService.postCustomOrderFinalRelease(tx, {
                    customOrderId,
                    brandId: order.brandId,
                    currency: finalAllocation.currency,
                    amount: Number(finalAllocation.amount),
                    commissionAmount: Number(finalAllocation.commissionAmount),
                    netBrandAmount: Number(finalAllocation.netBrandAmount),
                });
            }
            return next;
        });
        return {
            statusCode: 200,
            message: 'Custom order delivery confirmed',
            data: this.mapDetail(updated),
        };
    }
    async reportIssue(userId, customOrderId, dto) {
        const order = await this.requireBuyerOrder(userId, customOrderId);
        const now = new Date();
        const disputeEligibleStates = new Set([
            client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
            client_1.CustomOrderStatus.ACCEPTED,
            client_1.CustomOrderStatus.IN_PRODUCTION,
            client_1.CustomOrderStatus.READY_FOR_DISPATCH,
            client_1.CustomOrderStatus.IN_TRANSIT,
            client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
            client_1.CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
        ]);
        if (!disputeEligibleStates.has(order.status)) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_DISPUTE_WINDOW_CLOSED');
        }
        const normalizedEvidence = this.validateAndNormalizeIssueEvidence(dto.evidenceJson);
        const disputeIntakeQuestions = this.buildDisputeIntakeQuestions(dto.issueType);
        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.customOrderIssue.create({
                data: {
                    customOrderId,
                    issueType: dto.issueType,
                    description: dto.description.trim(),
                    evidenceJson: normalizedEvidence,
                    openedById: userId,
                },
            });
            const openDispute = await tx.customOrderDispute.findFirst({
                where: {
                    customOrderId,
                    status: { in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'] },
                },
            });
            if (!openDispute) {
                await tx.customOrderDispute.create({
                    data: {
                        customOrderId,
                        openedById: userId,
                        reasonType: dto.issueType,
                        buyerStatement: dto.description.trim(),
                    },
                });
            }
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    status: client_1.CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
                    issueReportedAt: now,
                    timelineEvents: {
                        create: [
                            {
                                actorType: client_1.CustomOrderActorType.BUYER,
                                actorId: userId,
                                eventType: 'DELIVERY_ISSUE_REPORTED',
                                payloadJson: {
                                    issueType: dto.issueType,
                                },
                            },
                            {
                                actorType: client_1.CustomOrderActorType.SYSTEM,
                                eventType: 'DISPUTE_CREATED',
                                payloadJson: {
                                    issueType: dto.issueType,
                                    intakeQuestions: disputeIntakeQuestions,
                                    intakeEvidenceProvided: {
                                        hasText: true,
                                        photoCount: normalizedEvidence.photos.length,
                                        optionalFileCount: (normalizedEvidence.files ?? []).length,
                                    },
                                },
                            },
                        ],
                    },
                },
                include: this.detailIncludes,
            });
            await tx.customOrderLedgerAllocation.updateMany({
                where: {
                    customOrderId,
                    allocationType: client_1.CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
                    status: { in: [client_1.CustomOrderLedgerAllocationStatus.HELD, client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE] },
                },
                data: {
                    status: client_1.CustomOrderLedgerAllocationStatus.FORFEITED,
                },
            });
            return next;
        });
        await this.queueBrandNotification(order.brandId, 'CUSTOM_ORDER_ISSUE_REPORTED', customOrderId, { issueType: dto.issueType });
        await this.queueBuyerNotification(userId, 'CUSTOM_ORDER_DISPUTE_CREATED', customOrderId, { reasonType: dto.issueType });
        return {
            statusCode: 200,
            message: 'Custom order issue reported',
            data: this.mapDetail(updated),
        };
    }
    async respondToExtension(userId, customOrderId, requestId, dto) {
        const order = await this.requireBuyerOrder(userId, customOrderId);
        const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
        if (!extensionRequest) {
            throw new common_1.NotFoundException('Custom order extension request not found');
        }
        if (extensionRequest.buyerResponseStatus !== client_1.CustomOrderExtensionResponseStatus.OPEN) {
            throw new common_1.BadRequestException('Extension request is no longer open');
        }
        const response = dto.response;
        const counterDays = dto.counterDays;
        if (response === client_1.CustomOrderExtensionResponseStatus.COUNTERED && !counterDays) {
            throw new common_1.BadRequestException('Counter response requires a counter day value');
        }
        if (response === client_1.CustomOrderExtensionResponseStatus.COUNTERED) {
            const existingCounter = order.extensionRequests.some((entry) => entry.id !== requestId &&
                (entry.buyerCounterDays != null ||
                    entry.buyerResponseStatus === client_1.CustomOrderExtensionResponseStatus.COUNTERED));
            if (existingCounter) {
                throw new common_1.BadRequestException('Only one extension counter is allowed per order');
            }
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.customOrderExtensionRequest.update({
                where: { id: requestId },
                data: {
                    buyerResponseStatus: response,
                    buyerCounterDays: response === client_1.CustomOrderExtensionResponseStatus.COUNTERED ? counterDays : null,
                    resolvedAt: response === client_1.CustomOrderExtensionResponseStatus.ACCEPTED ||
                        response === client_1.CustomOrderExtensionResponseStatus.REJECTED
                        ? new Date()
                        : null,
                },
            });
            if (response === client_1.CustomOrderExtensionResponseStatus.ACCEPTED) {
                await this.applyExtensionDays(tx, order.id, extensionRequest.requestedExtraDays, extensionRequest.targetType);
            }
            if (response === client_1.CustomOrderExtensionResponseStatus.REJECTED) {
                await tx.customOrderDispute.create({
                    data: {
                        customOrderId,
                        openedById: userId,
                        reasonType: client_1.CustomOrderIssueType.UNREASONABLE_DELAY,
                        buyerStatement: 'Buyer rejected brand extension request',
                    },
                });
                await tx.customOrder.update({
                    where: { id: customOrderId },
                    data: { status: client_1.CustomOrderStatus.DISPUTED },
                });
            }
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    timelineEvents: {
                        create: {
                            actorType: client_1.CustomOrderActorType.BUYER,
                            actorId: userId,
                            eventType: 'EXTENSION_RESOLVED',
                            payloadJson: {
                                requestId,
                                response,
                                counterDays: counterDays ?? null,
                            },
                        },
                    },
                },
                include: this.detailIncludes,
            });
            return next;
        });
        return {
            statusCode: 200,
            message: 'Custom order extension response recorded',
            data: this.mapDetail(updated),
        };
    }
    async respondToBuyerCounter(ownerUserId, brandId, customOrderId, requestId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
        if (!extensionRequest) {
            throw new common_1.NotFoundException('Custom order extension request not found');
        }
        if (extensionRequest.buyerResponseStatus !== client_1.CustomOrderExtensionResponseStatus.COUNTERED) {
            throw new common_1.BadRequestException('Extension request is not awaiting brand response');
        }
        if (!extensionRequest.buyerCounterDays) {
            throw new common_1.BadRequestException('Countered extension request is missing buyer counter days');
        }
        if (dto.response !== client_1.CustomOrderExtensionResponseStatus.ACCEPTED &&
            dto.response !== client_1.CustomOrderExtensionResponseStatus.REJECTED) {
            throw new common_1.BadRequestException('Brand response must accept or reject the buyer counter');
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.customOrderExtensionRequest.update({
                where: { id: requestId },
                data: {
                    buyerResponseStatus: dto.response,
                    resolvedAt: new Date(),
                },
            });
            if (dto.response === client_1.CustomOrderExtensionResponseStatus.ACCEPTED) {
                await this.applyExtensionDays(tx, order.id, extensionRequest.buyerCounterDays, extensionRequest.targetType);
            }
            return tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    timelineEvents: {
                        create: {
                            actorType: client_1.CustomOrderActorType.BRAND,
                            actorId: ownerUserId,
                            eventType: 'EXTENSION_RESOLVED',
                            payloadJson: {
                                requestId,
                                response: dto.response,
                                counterDays: extensionRequest.buyerCounterDays,
                                note: dto.note ?? null,
                            },
                        },
                    },
                },
                include: this.detailIncludes,
            });
        });
        await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_EXTENSION_RESOLVED', customOrderId, {
            response: dto.response,
            counterDays: extensionRequest.buyerCounterDays,
        });
        return {
            statusCode: 200,
            message: 'Buyer counter response recorded',
            data: this.mapDetail(updated),
        };
    }
    async getDisplayChartPreference(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { notificationSettings: true },
        });
        const settings = user?.notificationSettings;
        const customOrders = settings?.customOrders;
        const displayChartFamily = this.normalizeChartFamily(customOrders?.displayChartFamily);
        const updatedAtMs = Number(customOrders?.displayChartUpdatedAtMs ?? 0);
        return {
            statusCode: 200,
            message: 'Display chart preference retrieved',
            data: {
                displayChartFamily,
                updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
            },
        };
    }
    async updateDisplayChartPreference(userId, dto) {
        const displayChartFamily = this.normalizeChartFamily(dto.displayChartFamily);
        const updatedAtMs = dto.updatedAtMs ?? Date.now();
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { notificationSettings: true },
        });
        const existing = user?.notificationSettings ?? {};
        const next = {
            ...existing,
            customOrders: {
                ...(existing.customOrders ?? {}),
                displayChartFamily,
                displayChartUpdatedAtMs: updatedAtMs,
            },
        };
        await this.prisma.user.update({
            where: { id: userId },
            data: { notificationSettings: next },
        });
        return {
            statusCode: 200,
            message: 'Display chart preference updated',
            data: { displayChartFamily, updatedAtMs },
        };
    }
    async createExceptionReviewRequest(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        if (order.status !== client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE) {
            throw new common_1.BadRequestException('EXCEPTION_REVIEW_NOT_ALLOWED_FOR_STATE');
        }
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const monthCount = await this.prisma.customOrderTimelineEvent.count({
            where: {
                eventType: 'ADMIN_ESCALATED',
                actorType: client_1.CustomOrderActorType.BRAND,
                actorId: ownerUserId,
                createdAt: { gte: monthStart },
            },
        });
        if (monthCount >= EXCEPTION_REVIEW_MONTHLY_QUOTA) {
            throw new common_1.BadRequestException('EXCEPTION_REVIEW_MONTHLY_QUOTA_EXCEEDED');
        }
        const dueAt = new Date(Date.now() + EXCEPTION_REVIEW_SLA_HOURS * 60 * 60 * 1000);
        const updated = await this.prisma.customOrder.update({
            where: { id: customOrderId },
            data: {
                timelineEvents: {
                    create: {
                        actorType: client_1.CustomOrderActorType.BRAND,
                        actorId: ownerUserId,
                        eventType: 'ADMIN_ESCALATED',
                        payloadJson: {
                            kind: 'EXCEPTION_REVIEW_REQUEST',
                            status: 'NEW',
                            requestedQuoteTotal: dto.requestedQuoteTotal ?? null,
                            reason: dto.reason.trim(),
                            dueAt: dueAt.toISOString(),
                            chartLock: this.normalizeChartLock(order.internalPriceBreakdownJson?.chartLock),
                        },
                    },
                },
            },
            include: this.detailIncludes,
        });
        return {
            statusCode: 201,
            message: 'Exception review request submitted',
            data: this.mapDetail(updated),
        };
    }
    async listBrandOrders(ownerUserId, brandId, query) {
        const brand = await this.resolveBrand(ownerUserId);
        if (brand.id !== brandId) {
            throw new common_1.ForbiddenException('Not authorized for this brand');
        }
        return this.listOrders({ brandId }, query);
    }
    async getBrandOrder(ownerUserId, brandId, customOrderId) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        return {
            statusCode: 200,
            message: 'Custom order retrieved',
            data: this.mapDetail(order),
        };
    }
    async acceptBrandOrder(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        if (order.status === client_1.CustomOrderStatus.ACCEPTED || order.status === client_1.CustomOrderStatus.IN_PRODUCTION) {
            return {
                statusCode: 200,
                message: 'Custom order already accepted',
                data: this.mapDetail(order),
            };
        }
        if (order.status !== client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE || order.paymentStatus !== 'PAID') {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE');
        }
        const now = new Date();
        const promisedProductionAt = new Date(now.getTime() + order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000);
        const promisedDispatchAt = promisedProductionAt;
        const promisedDeliveryAt = new Date(promisedDispatchAt.getTime() + order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000);
        const updated = await this.prisma.$transaction(async (tx) => {
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    status: client_1.CustomOrderStatus.ACCEPTED,
                    acceptedAt: now,
                    promisedProductionAt,
                    promisedDispatchAt,
                    promisedDeliveryAt,
                    currentProgressStage: client_1.CustomOrderProgressStage.ORDER_RECEIVED,
                    currentProgressStageEnteredAt: now,
                    lastBrandProgressUpdateAt: now,
                    progressEvents: {
                        create: {
                            stage: client_1.CustomOrderProgressStage.ORDER_RECEIVED,
                            note: dto.note?.trim() || null,
                            changedById: ownerUserId,
                            staleThresholdAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                        },
                    },
                    timelineEvents: {
                        create: {
                            actorType: client_1.CustomOrderActorType.BRAND,
                            actorId: ownerUserId,
                            eventType: 'BRAND_ACCEPTED',
                            payloadJson: dto.note ? { note: dto.note } : client_1.Prisma.JsonNull,
                        },
                    },
                },
                include: this.detailIncludes,
            });
            await tx.customOrderLedgerAllocation.updateMany({
                where: {
                    customOrderId,
                    allocationType: client_1.CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
                    status: client_1.CustomOrderLedgerAllocationStatus.HELD,
                },
                data: {
                    status: client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                    eligibleAt: now,
                },
            });
            return next;
        });
        await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_BRAND_ACCEPTED', customOrderId, { brandName: order.sourceBrandNameSnapshot });
        return {
            statusCode: 200,
            message: 'Custom order accepted',
            data: this.mapDetail(updated),
        };
    }
    async rejectBrandOrder(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        if (order.status === client_1.CustomOrderStatus.REJECTED_BY_BRAND) {
            return {
                statusCode: 200,
                message: 'Custom order already rejected',
                data: this.mapDetail(order),
            };
        }
        if (order.paymentStatus === client_1.PaymentStatus.PAID) {
            throw new common_1.ForbiddenException('Paid custom orders are auto-accepted. Only a super admin can cancel the order and trigger a full refund.');
        }
        if (order.status !== client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE');
        }
        const updated = await this.prisma.$transaction(async (tx) => {
            const next = await tx.customOrder.update({
                where: { id: customOrderId },
                data: {
                    status: client_1.CustomOrderStatus.REJECTED_BY_BRAND,
                    rejectedAt: new Date(),
                    timelineEvents: {
                        create: [
                            {
                                actorType: client_1.CustomOrderActorType.BRAND,
                                actorId: ownerUserId,
                                eventType: 'BRAND_REJECTED',
                                payloadJson: { reason: dto.reason },
                            },
                            {
                                actorType: client_1.CustomOrderActorType.SYSTEM,
                                eventType: 'REFUND_INITIATED',
                                payloadJson: { reason: 'brand_rejected' },
                            },
                        ],
                    },
                },
                include: this.detailIncludes,
            });
            await tx.customOrderLedgerAllocation.updateMany({
                where: { customOrderId },
                data: {
                    status: client_1.CustomOrderLedgerAllocationStatus.REVERSED,
                    reversedAt: new Date(),
                    reversalReason: 'BRAND_REJECTED',
                },
            });
            await this.refundService.initiateRefund(tx, {
                customOrderId,
                reason: 'BRAND_REJECTED',
                actorType: client_1.CustomOrderActorType.BRAND,
                actorId: ownerUserId,
            });
            return next;
        });
        await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_BRAND_REJECTED', customOrderId, { reason: dto.reason });
        return {
            statusCode: 200,
            message: 'Custom order rejected',
            data: this.mapDetail(updated),
        };
    }
    async updateBrandProgressStage(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        if (![
            client_1.CustomOrderStatus.ACCEPTED,
            client_1.CustomOrderStatus.IN_PRODUCTION,
            client_1.CustomOrderStatus.READY_FOR_DISPATCH,
        ].includes(order.status)) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE');
        }
        const now = new Date();
        const nextStatus = dto.stage === client_1.CustomOrderProgressStage.READY_FOR_DELIVERY
            ? client_1.CustomOrderStatus.READY_FOR_DISPATCH
            : client_1.CustomOrderStatus.IN_PRODUCTION;
        const updated = await this.prisma.customOrder.update({
            where: { id: customOrderId },
            data: {
                status: nextStatus,
                currentProgressStage: dto.stage,
                currentProgressStageEnteredAt: now,
                lastBrandProgressUpdateAt: now,
                progressEvents: {
                    create: {
                        stage: dto.stage,
                        note: dto.note?.trim() || null,
                        changedById: ownerUserId,
                        staleThresholdAt: this.resolveStageThreshold(dto.stage, now),
                    },
                },
                timelineEvents: {
                    create: {
                        actorType: client_1.CustomOrderActorType.BRAND,
                        actorId: ownerUserId,
                        eventType: 'PROGRESS_STAGE_CHANGED',
                        payloadJson: {
                            stage: dto.stage,
                            note: dto.note ?? null,
                        },
                    },
                },
            },
            include: this.detailIncludes,
        });
        await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_PROGRESS_UPDATED', customOrderId, { stage: dto.stage, note: dto.note ?? null });
        return {
            statusCode: 200,
            message: 'Custom order progress stage updated',
            data: this.mapDetail(updated),
        };
    }
    async createExtensionRequest(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        if (order.extensionRequests.length > 0) {
            throw new common_1.BadRequestException('Only one extension request is allowed per order');
        }
        if (!this.isExtensionRequestAllowed(order.status, dto.targetType)) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_EXTENSION_NOT_ALLOWED_FOR_STATE');
        }
        const updated = await this.prisma.customOrder.update({
            where: { id: customOrderId },
            data: {
                extensionRequests: {
                    create: {
                        requestedByBrandId: brandId,
                        targetType: dto.targetType,
                        requestedExtraDays: dto.requestedExtraDays,
                        reason: dto.reason.trim(),
                    },
                },
                timelineEvents: {
                    create: {
                        actorType: client_1.CustomOrderActorType.BRAND,
                        actorId: ownerUserId,
                        eventType: 'EXTENSION_REQUESTED',
                        payloadJson: {
                            targetType: dto.targetType,
                            requestedExtraDays: dto.requestedExtraDays,
                            reason: dto.reason,
                        },
                    },
                },
            },
            include: this.detailIncludes,
        });
        await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_EXTENSION_REQUESTED', customOrderId, {
            requestedExtraDays: dto.requestedExtraDays,
            targetType: dto.targetType,
        });
        return {
            statusCode: 201,
            message: 'Custom order extension request created',
            data: this.mapDetail(updated),
        };
    }
    async updateLifecycleStatus(ownerUserId, brandId, customOrderId, dto) {
        await this.assertBrandOwnership(ownerUserId, brandId);
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, brandId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        const allowedStatuses = new Set([
            client_1.CustomOrderStatus.READY_FOR_DISPATCH,
            client_1.CustomOrderStatus.IN_TRANSIT,
            client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
            client_1.CustomOrderStatus.CLOSED,
        ]);
        if (!allowedStatuses.has(dto.status)) {
            throw new common_1.BadRequestException('Unsupported custom-order lifecycle transition');
        }
        if (!this.isLifecycleTransitionAllowed(order.status, dto.status)) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_INVALID_STATE_TRANSITION');
        }
        const now = new Date();
        const updated = await this.prisma.customOrder.update({
            where: { id: customOrderId },
            data: {
                status: dto.status,
                deliveredAt: dto.status === client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION ? now : order.deliveredAt,
                buyerAcceptanceWindowEndsAt: dto.status === client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
                    ? new Date(now.getTime() + BUYER_ACCEPTANCE_WINDOW_HOURS * 60 * 60 * 1000)
                    : order.buyerAcceptanceWindowEndsAt,
                timelineEvents: {
                    create: {
                        actorType: client_1.CustomOrderActorType.BRAND,
                        actorId: ownerUserId,
                        eventType: dto.status === client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
                            ? 'DELIVERED'
                            : 'PROGRESS_STAGE_CHANGED',
                        payloadJson: {
                            status: dto.status,
                            note: dto.note ?? null,
                        },
                    },
                },
            },
            include: this.detailIncludes,
        });
        if (dto.status === client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
            await this.queueBuyerNotification(order.buyerId, 'CUSTOM_ORDER_DELIVERED', customOrderId);
        }
        return {
            statusCode: 200,
            message: 'Custom order lifecycle status updated',
            data: this.mapDetail(updated),
        };
    }
    async updateBuyerMeasurementsBeforeAcceptance(userId, customOrderId, dto) {
        const order = await this.requireBuyerOrder(userId, customOrderId);
        if (order.status !== client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE ||
            order.paymentStatus !== client_1.PaymentStatus.PAID ||
            order.acceptedAt) {
            throw new common_1.BadRequestException('CUSTOM_ORDER_MEASUREMENT_UPDATE_WINDOW_CLOSED');
        }
        const configuration = await this.getConfigurationVersion(order.configurationId, order.configurationVersionId);
        const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(configuration.snapshot.requiredMeasurementKeys ?? [], configuration.snapshot.requiredFreeformPointIds ?? [], dto.measurementValues);
        await this.validateMeasurementRanges(requiredMeasurementKeys, dto.measurementValues);
        const yardProfile = this.parseConfigurationYardProfile(typeof configuration.snapshot.notes === 'string' ? configuration.snapshot.notes : null);
        const chartLock = this.normalizeChartLock(order.internalPriceBreakdownJson?.chartLock);
        const revalidatedPreview = this.pricingService.buildPricePreview({
            baseProductionCharge: configuration.snapshot.baseProductionCharge,
            fabricCostPerYard: configuration.snapshot.fabricCostPerYard,
            rushEnabled: configuration.snapshot.rushEnabled,
            rushFee: configuration.snapshot.rushFee,
            baseYardsOverride: yardProfile?.averageBaseYards,
            additionalYards: this.resolveAdditionalYardsFromProfile(yardProfile, chartLock.computedSize),
            rules: this.pricingService.validateConfigurationRules((configuration.snapshot.rules ?? []).map((rule) => ({
                priority: Number(rule.priority),
                outputYards: String(rule.outputYards),
                isFallback: Boolean(rule.isFallback),
                conditionsJson: this.conditionsFromSnapshot(rule.conditions),
            }))),
            requiredMeasurementKeys,
            measurementValues: dto.measurementValues,
            rushSelected: order.rushSelected,
            shippingAddress: order.shippingAddressJson ?? undefined,
            currency: order.currency,
        });
        const existingGrandTotal = Number(order.buyerPriceSummaryJson?.grandTotal ?? 0);
        const revalidatedGrandTotal = Number(revalidatedPreview.buyerPriceSummary.grandTotal ?? 0);
        if (existingGrandTotal !== revalidatedGrandTotal) {
            throw new common_1.BadRequestException('Measurement update changes the locked payable total. Please create a new preview and contact support/admin for settlement revalidation.');
        }
        const requiredMeasurementSnapshot = requiredMeasurementKeys.reduce((accumulator, key) => {
            const value = Number(dto.measurementValues[key]);
            if (Number.isFinite(value)) {
                accumulator[key] = value;
            }
            return accumulator;
        }, {});
        const updated = await this.prisma.customOrder.update({
            where: { id: customOrderId },
            data: {
                measurementSnapshotJson: dto.measurementValues,
                measurementConfirmedAt: new Date(),
                internalPriceBreakdownJson: {
                    ...order.internalPriceBreakdownJson,
                    requiredMeasurementSnapshot,
                    measurementAttachmentMeta: {
                        attachedAt: new Date().toISOString(),
                        requiredMeasurementKeys,
                        requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
                        updatedBeforeAcceptance: true,
                        updateReason: dto.reason ?? null,
                    },
                },
                timelineEvents: {
                    create: {
                        actorType: client_1.CustomOrderActorType.BUYER,
                        actorId: userId,
                        eventType: 'PRICE_PREVIEW_CREATED',
                        payloadJson: {
                            action: 'MEASUREMENTS_UPDATED_PRE_ACCEPTANCE',
                            reason: dto.reason ?? null,
                            requiredMeasurementKeys,
                            requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
                        },
                    },
                },
            },
            include: this.detailIncludes,
        });
        await this.queueBrandNotification(order.brandId, 'CUSTOM_ORDER_REVIEW_REQUIRED', customOrderId, {
            reason: 'MEASUREMENTS_UPDATED_PRE_ACCEPTANCE',
        });
        return {
            statusCode: 200,
            message: 'Custom order measurements updated and revalidated',
            data: this.mapDetail(updated),
        };
    }
    async queueBuyerNotification(recipientId, notificationType, customOrderId, payload = {}) {
        await this.sideEffects.enqueueNotification({
            customOrderId,
            recipientIds: [recipientId],
            notificationType,
            payload: {
                customOrderId,
                targetUrl: `/custom-orders/${customOrderId}`,
                ...payload,
            },
            dedupeMs: 5 * 60 * 1000,
        });
    }
    async queueBrandNotification(brandId, notificationType, customOrderId, payload = {}) {
        const brand = await this.prisma.brand.findUnique({
            where: { id: brandId },
            select: { ownerId: true },
        });
        if (!brand?.ownerId) {
            return;
        }
        await this.sideEffects.enqueueNotification({
            customOrderId,
            recipientIds: [brand.ownerId],
            notificationType,
            payload: {
                customOrderId,
                targetUrl: `/studio/custom-orders/${customOrderId}`,
                ...payload,
            },
            dedupeMs: 5 * 60 * 1000,
        });
    }
    async listOrders(where, query) {
        const page = query.page ?? 1;
        const take = query.limit ?? 20;
        const finalWhere = {
            ...where,
            ...(query.status ? { status: query.status } : {}),
            ...(query.stage ? { currentProgressStage: query.stage } : {}),
            ...(query.q
                ? {
                    OR: [
                        { sourceTitleSnapshot: { contains: query.q, mode: 'insensitive' } },
                        { sourceBrandNameSnapshot: { contains: query.q, mode: 'insensitive' } },
                    ],
                }
                : {}),
        };
        const [items, total] = await this.prisma.$transaction([
            this.prisma.customOrder.findMany({
                where: finalWhere,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * take,
                take,
            }),
            this.prisma.customOrder.count({ where: finalWhere }),
        ]);
        return {
            statusCode: 200,
            message: 'Custom orders retrieved',
            data: {
                items: items.map((item) => this.mapListItem(item)),
                page,
                limit: take,
                total,
            },
        };
    }
    async requireBuyerOrder(userId, customOrderId) {
        const order = await this.prisma.customOrder.findFirst({
            where: { id: customOrderId, buyerId: userId },
            include: this.detailIncludes,
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        return order;
    }
    async resolveBrand(ownerUserId) {
        const brand = await this.prisma.brand.findUnique({
            where: { ownerId: ownerUserId },
            select: { id: true },
        });
        if (!brand) {
            throw new common_1.NotFoundException('Brand profile not found');
        }
        return brand;
    }
    async assertBrandOwnership(ownerUserId, brandId) {
        const brand = await this.resolveBrand(ownerUserId);
        if (brand.id !== brandId) {
            throw new common_1.ForbiddenException('Not authorized for this brand');
        }
    }
    async getActiveConfiguration(configurationId, requestedVersionId) {
        const configuration = await this.prisma.customOrderConfiguration.findUnique({
            where: { id: configurationId },
            include: {
                brand: { select: { currency: true } },
                rules: { orderBy: { priority: 'asc' } },
                versions: {
                    where: requestedVersionId ? { id: requestedVersionId } : undefined,
                    orderBy: { version: 'desc' },
                    take: 1,
                },
            },
        });
        if (!configuration || !configuration.isActive) {
            throw new common_1.NotFoundException('Custom order configuration not found');
        }
        const version = configuration.versions[0];
        if (!version) {
            throw new common_1.NotFoundException('Custom order configuration version not found');
        }
        return { ...configuration, version };
    }
    async getConfigurationVersion(configurationId, versionId) {
        const configuration = await this.prisma.customOrderConfiguration.findUnique({
            where: { id: configurationId },
            include: {
                brand: { select: { currency: true } },
                rules: { orderBy: { priority: 'asc' } },
                versions: { where: { id: versionId }, take: 1 },
            },
        });
        if (!configuration || configuration.versions.length === 0) {
            throw new common_1.NotFoundException('Custom order configuration version not found');
        }
        const version = configuration.versions[0];
        const snapshot = version.snapshotJson;
        return {
            configuration,
            version,
            snapshot,
        };
    }
    conditionsFromSnapshot(conditions) {
        if (!Array.isArray(conditions)) {
            return {};
        }
        return conditions.reduce((accumulator, entry) => {
            const condition = entry;
            accumulator[String(condition.key)] = {
                min: condition.min,
                max: condition.max,
            };
            return accumulator;
        }, {});
    }
    buildCheckoutIntentRequestSnapshot(measurementValues, rushSelected, shippingAddress, matchedFabricRuleId, chartLock) {
        return {
            measurementValues,
            rushSelected: Boolean(rushSelected),
            shippingAddress: shippingAddress ?? null,
            matchedFabricRuleId,
            chartLock: chartLock ?? {
                pricingChartFamily: DEFAULT_PRICING_CHART_FAMILY,
                displayChartFamily: DEFAULT_DISPLAY_CHART_FAMILY,
                resolverPolicy: DEFAULT_RESOLVER_POLICY,
                chartVersionId: this.currentChartVersionId(),
                computedSize: null,
                noDirectMatch: false,
                conversionGuidance: null,
                quoteStatus: 'AUTO_PRICED',
            },
        };
    }
    normalizeCheckoutIntentRequestSnapshot(snapshot) {
        const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
            ? snapshot
            : {};
        return this.buildCheckoutIntentRequestSnapshot(value.measurementValues ?? {}, Boolean(value.rushSelected), value.shippingAddress ?? null, typeof value.matchedFabricRuleId === 'string' ? value.matchedFabricRuleId : null, this.normalizeChartLock(value.chartLock));
    }
    normalizeChartLock(raw) {
        const lock = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw
            : {};
        const pricingChartFamily = this.normalizeChartFamily(lock.pricingChartFamily);
        const displayChartFamily = this.normalizeChartFamily(lock.displayChartFamily);
        const resolverPolicy = this.normalizeResolverPolicy(lock.resolverPolicy);
        return {
            pricingChartFamily,
            displayChartFamily,
            resolverPolicy,
            chartVersionId: typeof lock.chartVersionId === 'string' && lock.chartVersionId.trim().length > 0
                ? lock.chartVersionId
                : this.currentChartVersionId(),
            computedSize: typeof lock.computedSize === 'string' ? lock.computedSize : null,
            noDirectMatch: Boolean(lock.noDirectMatch),
            conversionGuidance: typeof lock.conversionGuidance === 'string' ? lock.conversionGuidance : null,
            quoteStatus: lock.quoteStatus === 'MANUAL_QUOTE_REQUIRED' ? 'MANUAL_QUOTE_REQUIRED' : 'AUTO_PRICED',
        };
    }
    normalizeChartFamily(value) {
        const v = typeof value === 'string' ? value.toUpperCase() : '';
        if (v === 'UK' ||
            v === 'US' ||
            v === 'NIGERIA' ||
            v === 'ASIA' ||
            v === 'HYBRID_UK_NIGERIA' ||
            v === 'HYBRID_US_NIGERIA') {
            return v;
        }
        return DEFAULT_PRICING_CHART_FAMILY;
    }
    normalizeResolverPolicy(value) {
        const v = typeof value === 'string' ? value.toUpperCase() : '';
        if (v === 'PRIMARY_ONLY' || v === 'MAX_OF_BOTH' || v === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
            return v;
        }
        return DEFAULT_RESOLVER_POLICY;
    }
    currentChartVersionId() {
        return `chart-pack-v2-${new Date().getUTCFullYear()}Q1`;
    }
    validateAndNormalizeIssueEvidence(evidenceJson) {
        const normalized = evidenceJson && typeof evidenceJson === 'object' && !Array.isArray(evidenceJson)
            ? { ...evidenceJson }
            : {};
        const photos = Array.isArray(normalized.photos)
            ? normalized.photos.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            : [];
        if (photos.length === 0) {
            throw new common_1.BadRequestException('Dispute evidence must include at least one photo');
        }
        const files = Array.isArray(normalized.files)
            ? normalized.files.filter((entry) => entry && typeof entry === 'object')
            : [];
        return {
            ...normalized,
            photos,
            files,
        };
    }
    buildDisputeIntakeQuestions(issueType) {
        const base = [
            {
                key: 'summary',
                question: 'Briefly describe what went wrong with this custom order.',
                required: true,
            },
            {
                key: 'impact',
                question: 'How is this issue affecting delivery, fit, or usability?',
                required: true,
            },
            {
                key: 'preferred_resolution',
                question: 'What outcome are you requesting (refund, remake, adjustment, or other)?',
                required: true,
            },
        ];
        const issueSpecific = {
            WRONG_ITEM: [
                { key: 'received_item_description', question: 'What item did you receive instead?', required: true },
            ],
            MATERIAL_DEFECT: [
                { key: 'defect_location', question: 'Where is the material defect located?', required: true },
            ],
            MEASUREMENT_NON_COMPLIANCE: [
                { key: 'fit_problem_area', question: 'Which fit areas are incorrect?', required: true },
            ],
            UNFINISHED_WORK: [
                { key: 'unfinished_parts', question: 'Which parts of the outfit are unfinished?', required: true },
            ],
            NON_DELIVERY: [
                { key: 'last_delivery_update', question: 'What was the last delivery update you received?', required: true },
            ],
            UNREASONABLE_DELAY: [
                { key: 'delay_duration', question: 'How long has the delay lasted so far?', required: true },
            ],
            OTHER: [
                { key: 'other_details', question: 'Provide details for this issue type.', required: true },
            ],
        };
        return [...base, ...issueSpecific[issueType]];
    }
    resolveAdditionalYardsFromProfile(profile, computedSize) {
        if (!computedSize) {
            return 0;
        }
        if (!profile || !Array.isArray(profile.sizeExtraYards) || profile.sizeExtraYards.length === 0) {
            return 0;
        }
        const normalize = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const target = normalize(computedSize);
        const compactTarget = normalize(computedSize.replace(/^(UK|US|NG|NIGERIA|ASIA)\s*/i, ''));
        const matched = profile.sizeExtraYards.find((row) => {
            const normalizedLabel = normalize(String(row?.sizeLabel ?? ''));
            return normalizedLabel === target || normalizedLabel === compactTarget;
        });
        return matched ? Number(matched.extraYards) || 0 : 0;
    }
    parseConfigurationYardProfile(notes) {
        const raw = String(notes ?? '');
        const prefix = 'YARD_PROFILE:';
        if (!raw.startsWith(prefix)) {
            return null;
        }
        const jsonLine = raw.slice(prefix.length).split('\n')[0]?.trim();
        if (!jsonLine) {
            return null;
        }
        try {
            const parsed = JSON.parse(jsonLine);
            return {
                averageBaseYards: typeof parsed.averageBaseYards === 'number' && Number.isFinite(parsed.averageBaseYards)
                    ? parsed.averageBaseYards
                    : undefined,
                sizeExtraYards: Array.isArray(parsed.sizeExtraYards)
                    ? parsed.sizeExtraYards
                        .map((row) => ({
                        sizeLabel: String(row?.sizeLabel ?? '').trim(),
                        extraYards: Number(row?.extraYards),
                    }))
                        .filter((row) => row.sizeLabel.length > 0 && Number.isFinite(row.extraYards) && row.extraYards >= 0)
                    : [],
            };
        }
        catch {
            return null;
        }
    }
    resolveChartEvaluation(input) {
        const required = ['BUST', 'WAIST', 'HIPS'];
        const indexed = Object.entries(input.measurementValues).reduce((acc, [k, v]) => {
            acc[k.toUpperCase()] = Number(v);
            return acc;
        }, {});
        for (const key of required) {
            const direct = indexed[key];
            const women = indexed[`WOMEN_${key}`];
            const men = key === 'BUST'
                ? indexed.MEN_CHEST
                : key === 'HIPS'
                    ? indexed.MEN_HIP
                    : indexed[`MEN_${key}`];
            const value = Number.isFinite(direct) ? direct : Number.isFinite(women) ? women : men;
            if (!Number.isFinite(value) || value <= 0) {
                return {
                    manualQuoteRequired: true,
                    quoteStatus: 'MANUAL_QUOTE_REQUIRED',
                    pricingChartFamily: input.pricingChartFamily,
                    displayChartFamily: input.displayChartFamily,
                    resolverPolicy: input.resolverPolicy,
                    chartVersionId: this.currentChartVersionId(),
                    computedSize: null,
                    noDirectMatch: false,
                    conversionGuidance: `Missing required measurement: ${key.toLowerCase()}`,
                };
            }
            indexed[key] = value;
        }
        const computeFromFamily = (family) => {
            const bands = CHART_BANDS[family];
            const exact = bands.findIndex((band, idx) => {
                const inBust = indexed.BUST >= band.bustMin && (idx === bands.length - 1 ? indexed.BUST <= band.bustMax : indexed.BUST < band.bustMax);
                const inWaist = indexed.WAIST >= band.waistMin && (idx === bands.length - 1 ? indexed.WAIST <= band.waistMax : indexed.WAIST < band.waistMax);
                const inHips = indexed.HIPS >= band.hipsMin && (idx === bands.length - 1 ? indexed.HIPS <= band.hipsMax : indexed.HIPS < band.hipsMax);
                return inBust && inWaist && inHips;
            });
            if (exact >= 0) {
                return { family, label: bands[exact].label, bandIndex: exact, noDirectMatch: false };
            }
            const nearest = bands.reduce((best, band, idx) => {
                const midpoint = (band.bustMin + band.bustMax + band.waistMin + band.waistMax + band.hipsMin + band.hipsMax) / 6;
                const delta = Math.abs(midpoint - (indexed.BUST + indexed.WAIST + indexed.HIPS) / 3);
                if (delta < best.delta) {
                    return { delta, idx, label: band.label };
                }
                return best;
            }, { delta: Number.MAX_SAFE_INTEGER, idx: 0, label: bands[0].label });
            return {
                family,
                label: nearest.label,
                bandIndex: nearest.idx,
                noDirectMatch: true,
                nearestLabel: nearest.label,
            };
        };
        const uk = computeFromFamily('UK');
        const ng = computeFromFamily('NIGERIA');
        const byFamily = {
            UK: uk,
            NIGERIA: ng,
            US: computeFromFamily('US'),
            ASIA: computeFromFamily('ASIA'),
        };
        let chosen;
        if (input.pricingChartFamily === 'HYBRID_UK_NIGERIA') {
            if (input.resolverPolicy === 'PRIMARY_ONLY') {
                chosen = uk;
            }
            else if (input.resolverPolicy === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
                const weighted = Math.round((uk.bandIndex * 0.6 + ng.bandIndex * 0.4));
                chosen = uk.bandIndex >= ng.bandIndex
                    ? { ...uk, bandIndex: Math.max(weighted, uk.bandIndex) }
                    : { ...ng, bandIndex: Math.max(weighted, ng.bandIndex) };
            }
            else {
                chosen = uk.bandIndex >= ng.bandIndex ? uk : ng;
            }
        }
        else if (input.pricingChartFamily === 'HYBRID_US_NIGERIA') {
            const us = byFamily.US;
            if (input.resolverPolicy === 'PRIMARY_ONLY') {
                chosen = us;
            }
            else if (input.resolverPolicy === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
                const weighted = Math.round((us.bandIndex * 0.6 + ng.bandIndex * 0.4));
                chosen = us.bandIndex >= ng.bandIndex
                    ? { ...us, bandIndex: Math.max(weighted, us.bandIndex) }
                    : { ...ng, bandIndex: Math.max(weighted, ng.bandIndex) };
            }
            else {
                chosen = us.bandIndex >= ng.bandIndex ? us : ng;
            }
        }
        else {
            chosen = byFamily[input.pricingChartFamily];
        }
        const displayCandidate = input.displayChartFamily === 'HYBRID_UK_NIGERIA' ||
            input.displayChartFamily === 'HYBRID_US_NIGERIA'
            ? chosen
            : byFamily[input.displayChartFamily];
        return {
            manualQuoteRequired: false,
            quoteStatus: 'AUTO_PRICED',
            pricingChartFamily: input.pricingChartFamily,
            displayChartFamily: input.displayChartFamily,
            resolverPolicy: input.resolverPolicy,
            chartVersionId: this.currentChartVersionId(),
            computedSize: chosen.label,
            noDirectMatch: chosen.noDirectMatch || displayCandidate.noDirectMatch,
            conversionGuidance: chosen.noDirectMatch || displayCandidate.noDirectMatch
                ? `Nearest mapped band: ${displayCandidate.nearestLabel ?? displayCandidate.label}`
                : null,
        };
    }
    inferMeasurementGenderFromKeys(keys) {
        for (const key of keys) {
            if (typeof key !== 'string')
                continue;
            if (key.startsWith('MEN_'))
                return 'MEN';
            if (key.startsWith('WOMEN_'))
                return 'WOMEN';
        }
        return null;
    }
    async resolveBaselineMeasurementKeys(gender) {
        const effectiveGender = gender ?? 'WOMEN';
        const orderedKeys = BASELINE_KEY_CANDIDATES[effectiveGender];
        const points = await this.prisma.measurementPoint.findMany({
            where: {
                key: { in: orderedKeys },
                source: 'SYSTEM',
                status: 'APPROVED_GLOBAL',
                isActive: true,
                OR: [{ gender: effectiveGender }, { gender: 'UNISEX' }, { gender: null }],
            },
            select: { key: true },
        });
        const byKey = new Set(points.map((point) => point.key));
        return orderedKeys.filter((key) => byKey.size === 0 || byKey.has(key));
    }
    async resolveRequiredMeasurementKeys(requiredMeasurementKeys, requiredFreeformPointIds, measurementValues = {}) {
        const inferredGender = this.inferMeasurementGenderFromKeys([
            ...requiredMeasurementKeys,
            ...Object.keys(measurementValues ?? {}),
        ]);
        const baselineKeys = await this.resolveBaselineMeasurementKeys(inferredGender);
        if (!requiredFreeformPointIds.length) {
            return Array.from(new Set([...requiredMeasurementKeys, ...baselineKeys]));
        }
        const points = await this.prisma.measurementPoint.findMany({
            where: { id: { in: requiredFreeformPointIds } },
            select: { key: true },
        });
        return Array.from(new Set([...requiredMeasurementKeys, ...points.map((point) => point.key), ...baselineKeys]));
    }
    async validateMeasurementRanges(requiredMeasurementKeys, measurementValues) {
        const points = await this.prisma.measurementPoint.findMany({
            where: { key: { in: requiredMeasurementKeys } },
            select: { key: true, minValueCm: true, maxValueCm: true },
        });
        for (const point of points) {
            const value = Number(measurementValues[point.key]);
            if (!Number.isFinite(value)) {
                throw new common_1.BadRequestException(`Missing measurement value for ${point.key}`);
            }
            if (point.minValueCm != null && value < Number(point.minValueCm)) {
                throw new common_1.BadRequestException(`Measurement value for ${point.key} is below the allowed minimum`);
            }
            if (point.maxValueCm != null && value > Number(point.maxValueCm)) {
                throw new common_1.BadRequestException(`Measurement value for ${point.key} exceeds the allowed maximum`);
            }
        }
    }
    async resolveSourceSnapshot(sourceType, sourceId) {
        if (sourceType === client_1.CustomOrderSourceType.PRODUCT) {
            const product = await this.prisma.product.findUnique({
                where: { id: sourceId },
                include: { brand: { select: { name: true } } },
            });
            if (!product) {
                throw new common_1.NotFoundException('Product source not found');
            }
            return {
                title: product.name,
                slug: product.slug,
                primaryMediaUrl: product.thumbnail ?? product.images[0] ?? null,
                brandName: product.brand.name,
            };
        }
        const design = await this.prisma.collection.findUnique({
            where: { id: sourceId },
            include: {
                owner: {
                    include: {
                        brand: { select: { name: true } },
                    },
                },
                coverMedia: {
                    include: {
                        file: { select: { s3Url: true } },
                    },
                },
                medias: {
                    take: 1,
                    orderBy: { orderIndex: 'asc' },
                    include: {
                        file: { select: { s3Url: true } },
                    },
                },
            },
        });
        if (!design) {
            throw new common_1.NotFoundException('Design source not found');
        }
        return {
            title: design.title ?? 'Untitled design',
            slug: null,
            primaryMediaUrl: design.coverMedia?.file.s3Url ?? design.medias[0]?.file.s3Url ?? null,
            brandName: design.owner.brand?.name ?? null,
        };
    }
    resolveStageThreshold(stage, from) {
        const hours = stage === client_1.CustomOrderProgressStage.FABRIC_AND_PIECE_PURCHASE_GATHERING ? 72 : 24;
        return new Date(from.getTime() + hours * 60 * 60 * 1000);
    }
    isExtensionRequestAllowed(status, targetType) {
        const productionEligible = new Set([
            client_1.CustomOrderStatus.ACCEPTED,
            client_1.CustomOrderStatus.IN_PRODUCTION,
        ]);
        const deliveryEligible = new Set([
            client_1.CustomOrderStatus.ACCEPTED,
            client_1.CustomOrderStatus.IN_PRODUCTION,
            client_1.CustomOrderStatus.READY_FOR_DISPATCH,
            client_1.CustomOrderStatus.IN_TRANSIT,
        ]);
        if (targetType === 'PRODUCTION') {
            return productionEligible.has(status);
        }
        if (targetType === 'DELIVERY') {
            return deliveryEligible.has(status);
        }
        return productionEligible.has(status);
    }
    isLifecycleTransitionAllowed(currentStatus, nextStatus) {
        const transitions = {
            [client_1.CustomOrderStatus.ACCEPTED]: [client_1.CustomOrderStatus.READY_FOR_DISPATCH],
            [client_1.CustomOrderStatus.IN_PRODUCTION]: [client_1.CustomOrderStatus.READY_FOR_DISPATCH],
            [client_1.CustomOrderStatus.READY_FOR_DISPATCH]: [client_1.CustomOrderStatus.IN_TRANSIT, client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
            [client_1.CustomOrderStatus.IN_TRANSIT]: [client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
            [client_1.CustomOrderStatus.COMPLETED]: [client_1.CustomOrderStatus.CLOSED],
        };
        return transitions[currentStatus]?.includes(nextStatus) ?? false;
    }
    async applyExtensionDays(tx, customOrderId, requestedExtraDays, targetType) {
        const order = await tx.customOrder.findUnique({ where: { id: customOrderId } });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        const dayMs = requestedExtraDays * 24 * 60 * 60 * 1000;
        await tx.customOrder.update({
            where: { id: customOrderId },
            data: {
                promisedProductionAt: targetType === 'PRODUCTION' || targetType === 'BOTH'
                    ? order.promisedProductionAt
                        ? new Date(order.promisedProductionAt.getTime() + dayMs)
                        : null
                    : order.promisedProductionAt,
                promisedDispatchAt: targetType === 'PRODUCTION' || targetType === 'BOTH'
                    ? order.promisedDispatchAt
                        ? new Date(order.promisedDispatchAt.getTime() + dayMs)
                        : null
                    : order.promisedDispatchAt,
                promisedDeliveryAt: order.promisedDeliveryAt
                    ? new Date(order.promisedDeliveryAt.getTime() + dayMs)
                    : null,
            },
        });
    }
    mapListItem(order) {
        const summary = order.buyerPriceSummaryJson;
        return {
            id: order.id,
            status: order.status,
            paymentStatus: order.paymentStatus,
            sourceType: order.sourceType,
            sourceId: order.sourceId,
            sourceTitle: order.sourceTitleSnapshot,
            brand: {
                name: order.sourceBrandNameSnapshot,
            },
            buyerPriceSummary: {
                grandTotal: summary?.grandTotal,
                currency: order.currency,
            },
            currentProgressStage: order.currentProgressStage,
            createdAt: order.createdAt,
        };
    }
    mapDetail(order) {
        const breakdown = (order.internalPriceBreakdownJson ?? {});
        const chartLock = (breakdown.chartLock ?? null);
        return {
            id: order.id,
            status: order.status,
            paymentStatus: order.paymentStatus,
            paymentReference: order.paymentReference,
            source: {
                type: order.sourceType,
                id: order.sourceId,
                title: order.sourceTitleSnapshot,
                slug: order.sourceSlugSnapshot,
                primaryMediaUrl: order.sourcePrimaryMediaUrlSnapshot,
                brandName: order.sourceBrandNameSnapshot,
            },
            configurationVersionId: order.configurationVersionId,
            buyerPriceSummary: order.buyerPriceSummaryJson,
            internalPriceBreakdown: order.internalPriceBreakdownJson,
            quoteStatus: chartLock?.quoteStatus ?? 'AUTO_PRICED',
            chartLock,
            exceptionDecision: (breakdown.exceptionDecision ?? null),
            measurementSnapshot: order.measurementSnapshotJson,
            measurementConfirmedAt: order.measurementConfirmedAt,
            currentProgressStage: order.currentProgressStage,
            acceptedAt: order.acceptedAt,
            buyerAcceptedAt: order.buyerAcceptedAt,
            completedAt: order.completedAt,
            promisedProductionAt: order.promisedProductionAt,
            promisedDispatchAt: order.promisedDispatchAt,
            promisedDeliveryAt: order.promisedDeliveryAt,
            buyerAcceptanceWindowEndsAt: order.buyerAcceptanceWindowEndsAt,
            measurementRetentionUntil: order.measurementRetentionUntil,
            anonymizedAt: order.anonymizedAt,
            retentionHoldType: order.retentionHoldType,
            retentionHoldReason: order.retentionHoldReason,
            retentionHoldUntil: order.retentionHoldUntil,
            retentionHoldSetById: order.retentionHoldSetById,
            retentionHoldSetAt: order.retentionHoldSetAt,
            progressEvents: order.progressEvents,
            extensionRequests: order.extensionRequests,
            issues: order.issues,
            disputes: order.disputes,
            timelineEvents: order.timelineEvents,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
        };
    }
    get detailIncludes() {
        return {
            progressEvents: { orderBy: { changedAt: 'asc' } },
            extensionRequests: { orderBy: { createdAt: 'desc' } },
            timelineEvents: { orderBy: { createdAt: 'asc' } },
            issues: { orderBy: { createdAt: 'desc' } },
            disputes: { orderBy: { openedAt: 'desc' } },
        };
    }
};
exports.CustomOrdersService = CustomOrdersService;
exports.CustomOrdersService = CustomOrdersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        custom_order_pricing_service_1.CustomOrderPricingService,
        custom_order_side_effects_service_1.CustomOrderSideEffectsService,
        custom_order_refund_service_1.CustomOrderRefundService,
        ledger_service_1.LedgerService])
], CustomOrdersService);
//# sourceMappingURL=custom-orders.service.js.map