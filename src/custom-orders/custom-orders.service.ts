import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderCheckoutStatus,
  CustomOrderActorType,
  CustomOrderExtensionResponseStatus,
  CustomOrderIssueType,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderProgressStage,
  CustomOrderSourceType,
  CustomOrderStatus,
  CustomOrderTimelineEventType,
  Gender,
  MeasurementPointSource,
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { validate as isUuid } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import { LedgerService } from 'src/finance/ledger.service';
import { resolveWebAppBaseUrl } from 'src/common/utils/web-app-url';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import {
  measurementKeysContainOppositeGender,
  normalizeIdList as normalizeIdArray,
  normalizeMeasurementKeyList as normalizeMeasurementKeyArray,
  resolveGarmentMeasurementTemplate,
  resolveSourceMeasurementGender,
} from './custom-order-measurement-contract.util';
import {
  AcceptCustomOrderDto,
  BrandRespondToCustomOrderExtensionCounterDto,
  CancelCustomOrderDto,
  ConfirmCustomOrderDeliveryDto,
  CreateExceptionReviewRequestDto,
  CreateCustomOrderDto,
  CreateCustomOrderExtensionRequestDto,
  CustomOrderChartFamily,
  CustomOrderPricePreviewDto,
  CustomOrderResolverPolicy,
  QueryCustomOrdersDto,
  RejectCustomOrderDto,
  ReportCustomOrderIssueDto,
  RespondToCustomOrderExtensionDto,
  UpdateDisplayChartPreferenceDto,
  UpdateCustomOrderMeasurementsDto,
  UpdateCustomOrderLifecycleStatusDto,
  UpdateCustomOrderProgressStageDto,
} from './dto/custom-orders.dto';

const BUYER_ACCEPTANCE_WINDOW_HOURS = 72;
const EXCEPTION_REVIEW_MONTHLY_QUOTA = 2;
const EXCEPTION_REVIEW_SLA_HOURS = 24;
const DEFAULT_PRICING_CHART_FAMILY: CustomOrderChartFamily = 'HYBRID_UK_NIGERIA';
const DEFAULT_DISPLAY_CHART_FAMILY: CustomOrderChartFamily = 'UK';
const DEFAULT_RESOLVER_POLICY: CustomOrderResolverPolicy = 'MAX_OF_BOTH';

type ChartBand = {
  label: string;
  bustMin: number;
  bustMax: number;
  waistMin: number;
  waistMax: number;
  hipsMin: number;
  hipsMax: number;
};

type ComputedChartCandidate = {
  family: CustomOrderChartFamily;
  label: string;
  bandIndex: number;
  noDirectMatch: boolean;
  nearestLabel?: string;
};

const CHART_BANDS: Record<
  Exclude<CustomOrderChartFamily, 'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA'>,
  ChartBand[]
> = {
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
const BASELINE_KEY_CANDIDATES: Record<'MEN' | 'WOMEN', string[]> = {
  MEN: [
    'MEN_HEIGHT',
    'MEN_SHOULDER',
    'MEN_CHEST',
    'MEN_WAIST',
    'MEN_HIP',
    'MEN_INSEAM',
    'MEN_SLEEVE_LENGTH',
  ],
  WOMEN: [
    'WOMEN_HEIGHT',
    'WOMEN_SHOULDER_WIDTH',
    'WOMEN_CHEST_FULL_BUST',
    'WOMEN_WAIST',
    'WOMEN_HIP',
    'WOMEN_INSEAM',
    'WOMEN_SLEEVE_LENGTH_LONG',
  ],
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',')}}`;
}

type CustomOrderRequestSnapshot = {
  measurementValues: Record<string, number>;
  rushSelected: boolean;
  shippingAddress: Record<string, unknown> | null;
  matchedFabricRuleId: string | null;
  chartLock: {
    pricingChartFamily: CustomOrderChartFamily;
    displayChartFamily: CustomOrderChartFamily;
    resolverPolicy: CustomOrderResolverPolicy;
    chartVersionId: string;
    computedSize: string | null;
    noDirectMatch: boolean;
    conversionGuidance: string | null;
    quoteStatus: 'AUTO_PRICED' | 'MANUAL_QUOTE_REQUIRED';
  };
};

type CustomOrderSubmissionMeta = {
  contactInfo: Record<string, unknown> | null;
  customerName: string | null;
  submissionIdempotencyKey: string | null;
  submittedAt: string | null;
  noDirectMatchAcknowledged: boolean;
};

const hasEphemeralMediaSignature = (value: unknown) => {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('x-amz-algorithm=') ||
    lower.includes('x-amz-signature=') ||
    lower.includes('x-amz-credential=') ||
    lower.includes('awsaccesskeyid=') ||
    lower.includes('signature=') ||
    /[?&]expires=/.test(lower)
  );
};

@Injectable()
export class CustomOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CustomOrderPricingService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly refundService: CustomOrderRefundService,
    private readonly ledgerService: LedgerService,
  ) {}

  async createPricePreview(userId: string, dto: CustomOrderPricePreviewDto) {
    const submittedMeasurementValues = this.normalizeMeasurementValues(dto.measurementValues);
    const configuration = await this.getActiveConfiguration(dto.configurationId, dto.configurationVersionId);
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      configuration.requiredMeasurementKeys,
      configuration.requiredFreeformPointIds,
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, submittedMeasurementValues);
    const buyerSavedMeasurements = await this.getBuyerSavedMeasurementValues(userId);

    const chartEvaluation = this.resolveChartEvaluation({
      measurementValues: {
        ...buyerSavedMeasurements,
        ...submittedMeasurementValues,
      },
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
            quoteStatus: 'MANUAL_QUOTE_REQUIRED' as const,
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
      rules: this.pricingService.validateConfigurationRules(
        configuration.rules.map((rule) => ({
          priority: rule.priority,
          outputYards: String(rule.outputYards),
          isFallback: rule.isFallback,
          conditionsJson: rule.conditionsJson as Record<string, unknown>,
        })),
      ),
      requiredMeasurementKeys,
      measurementValues: submittedMeasurementValues,
      rushSelected: dto.rushSelected,
      shippingAddress: dto.shippingAddress,
      currency: configuration.brand.currency,
    });
    const matchedRuleRecord = configuration.rules.find(
      (rule) =>
        rule.priority === preview.matchedRule.priority &&
        rule.isFallback === preview.matchedRule.isFallback,
    );

    const requestSnapshot = this.buildCheckoutIntentRequestSnapshot(
      submittedMeasurementValues,
      dto.rushSelected,
      dto.shippingAddress,
      matchedRuleRecord?.id ?? null,
      chartEvaluation,
    );
    const previewHash = createHash('sha256')
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
            requestSnapshotJson: requestSnapshot as Prisma.InputJsonValue,
            buyerPriceSummaryJson: preview.buyerPriceSummary as unknown as Prisma.InputJsonValue,
            expiresAt,
            consumedAt: null,
          },
          create: {
            buyerId: userId,
            configurationId: configuration.id,
            configurationVersionId: configuration.version.id,
            previewHash,
            requestSnapshotJson: requestSnapshot as Prisma.InputJsonValue,
            buyerPriceSummaryJson: preview.buyerPriceSummary as unknown as Prisma.InputJsonValue,
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
          quoteStatus: 'AUTO_PRICED' as const,
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

  async createOrder(userId: string, dto: CreateCustomOrderDto) {
    const submittedMeasurementValues = this.normalizeMeasurementValues(dto.measurementValues);
    const existingOrder = await this.prisma.customOrder.findFirst({
      where: {
        buyerId: userId,
        OR: [
          { idempotencyKey: dto.idempotencyKey },
          { checkoutIntentId: dto.checkoutIntentId },
        ],
      },
      select: {
        id: true,
        checkoutIntentId: true,
      },
    });
    if (existingOrder) {
      return {
        statusCode: 200,
        message: 'Custom order already placed for this checkout intent',
        data: {
          status: 'ALREADY_PLACED' as const,
          checkoutIntentId: existingOrder.checkoutIntentId ?? dto.checkoutIntentId,
          customOrderId: existingOrder.id,
        },
      };
    }

    const intent = await this.prisma.customOrderCheckoutIntent.findFirst({
      where: { id: dto.checkoutIntentId, buyerId: userId },
    });
    if (!intent) {
      throw new NotFoundException('Custom order checkout intent not found');
    }
    if (intent.expiresAt <= new Date()) {
      throw new BadRequestException('CUSTOM_ORDER_CHECKOUT_INTENT_EXPIRED');
    }
    if (intent.consumedAt) {
      throw new BadRequestException('Checkout intent has already been consumed');
    }
    if (intent.configurationId !== dto.configurationId) {
      throw new BadRequestException('CUSTOM_ORDER_CONFIGURATION_VERSION_MISMATCH');
    }
    if (dto.configurationVersionId && intent.configurationVersionId !== dto.configurationVersionId) {
      throw new BadRequestException('CUSTOM_ORDER_CONFIGURATION_VERSION_MISMATCH');
    }

    const intentSnapshot = this.normalizeCheckoutIntentRequestSnapshot(intent.requestSnapshotJson);
    const submittedSnapshot = this.buildCheckoutIntentRequestSnapshot(
      submittedMeasurementValues,
      dto.rushSelected,
      dto.shippingAddress,
      intentSnapshot.matchedFabricRuleId,
      intentSnapshot.chartLock,
    );
    if (stableStringify(intentSnapshot) !== stableStringify(submittedSnapshot)) {
      throw new BadRequestException('Checkout intent payload does not match current order request');
    }
    if (intentSnapshot.chartLock.quoteStatus === 'MANUAL_QUOTE_REQUIRED') {
      throw new BadRequestException('MANUAL_QUOTE_REQUIRED');
    }
    if (intentSnapshot.chartLock.noDirectMatch && !dto.noDirectMatchAcknowledged) {
      throw new BadRequestException('NO_DIRECT_MATCH_ACK_REQUIRED');
    }

    const submissionMeta = this.extractCheckoutIntentSubmissionMeta(intent.requestSnapshotJson);
    const alreadySubmitted = submissionMeta.submissionIdempotencyKey === dto.idempotencyKey;

    const configuration = await this.getConfigurationVersion(intent.configurationId, intent.configurationVersionId);
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      configuration.snapshot.requiredMeasurementKeys ?? [],
      configuration.snapshot.requiredFreeformPointIds ?? [],
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, submittedMeasurementValues);

    if (!alreadySubmitted) {
      await this.prisma.customOrderCheckoutIntent.update({
        where: { id: intent.id },
        data: {
          requestSnapshotJson: this.buildCheckoutIntentSubmissionSnapshot(intentSnapshot, {
            contactInfo: dto.contactInfo,
            customerName: dto.customerName,
            idempotencyKey: dto.idempotencyKey,
            noDirectMatchAcknowledged: dto.noDirectMatchAcknowledged,
          }) as Prisma.InputJsonValue,
        },
      });
    }

    const submittedAt =
      alreadySubmitted && submissionMeta.submittedAt
        ? new Date(submissionMeta.submittedAt)
        : new Date();
    const session = await this.prisma.customOrderCheckoutSession.upsert({
      where: { checkoutIntentId: intent.id },
      update: {
        status: CustomOrderCheckoutStatus.SUBMITTED,
        submittedAt,
        abandonedAt: null,
        uiStateJson: {
          step: 'SUBMITTED',
          measurementCount: Object.keys(submittedMeasurementValues).length,
          rushSelected: intentSnapshot.rushSelected,
          pricingChartFamily: intentSnapshot.chartLock.pricingChartFamily,
          displayChartFamily: intentSnapshot.chartLock.displayChartFamily,
          shippingCity: String((dto.shippingAddress as Record<string, unknown>)?.city ?? ''),
        } as Prisma.InputJsonValue,
      },
      create: {
        buyerId: userId,
        checkoutIntentId: intent.id,
        status: CustomOrderCheckoutStatus.SUBMITTED,
        submittedAt,
        resumeToken: this.generateCheckoutResumeToken(),
        uiStateJson: {
          step: 'SUBMITTED',
          measurementCount: Object.keys(submittedMeasurementValues).length,
          rushSelected: intentSnapshot.rushSelected,
          pricingChartFamily: intentSnapshot.chartLock.pricingChartFamily,
          displayChartFamily: intentSnapshot.chartLock.displayChartFamily,
          shippingCity: String((dto.shippingAddress as Record<string, unknown>)?.city ?? ''),
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        resumeToken: true,
      },
    });

    if (alreadySubmitted) {
      return {
        statusCode: 200,
        message: 'Custom order checkout already submitted',
        data: {
          status: 'READY_FOR_PAYMENT' as const,
          checkoutIntentId: intent.id,
          priceLockExpiresAt: intent.expiresAt.toISOString(),
          checkoutSessionId: session.id,
          resumeUrl: this.buildCheckoutResumeUrl(session.resumeToken),
        },
      };
    }

    return {
      statusCode: 201,
      message: 'Custom order checkout submitted. Complete payment to place the order.',
      data: {
        status: 'READY_FOR_PAYMENT' as const,
        checkoutIntentId: intent.id,
        priceLockExpiresAt: intent.expiresAt.toISOString(),
        checkoutSessionId: session.id,
        resumeUrl: this.buildCheckoutResumeUrl(session.resumeToken),
      },
    };
  }

  async buildPaidOrderCreateInput(params: {
    intent: Prisma.CustomOrderCheckoutIntentGetPayload<{}>;
    buyerId: string;
    paymentReference: string;
    paymentMethod: PaymentMethod;
    confirmedAt?: Date | null;
  }) {
    const intentSnapshot = this.normalizeCheckoutIntentRequestSnapshot(params.intent.requestSnapshotJson);
    const submissionMeta = this.extractCheckoutIntentSubmissionMeta(params.intent.requestSnapshotJson);

    if (intentSnapshot.chartLock.quoteStatus === 'MANUAL_QUOTE_REQUIRED') {
      throw new BadRequestException('MANUAL_QUOTE_REQUIRED');
    }
    if (intentSnapshot.chartLock.noDirectMatch && !submissionMeta.noDirectMatchAcknowledged) {
      throw new BadRequestException('NO_DIRECT_MATCH_ACK_REQUIRED');
    }
    if (!submissionMeta.contactInfo || !submissionMeta.customerName) {
      throw new BadRequestException('CUSTOM_ORDER_CHECKOUT_INCOMPLETE');
    }

    const submittedMeasurementValues = this.normalizeMeasurementValues(intentSnapshot.measurementValues);
    const configuration = await this.getConfigurationVersion(
      params.intent.configurationId,
      params.intent.configurationVersionId,
    );
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      configuration.snapshot.requiredMeasurementKeys ?? [],
      configuration.snapshot.requiredFreeformPointIds ?? [],
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, submittedMeasurementValues);
    const snapshotYardProfile = this.parseConfigurationYardProfile(
      typeof configuration.snapshot.notes === 'string' ? configuration.snapshot.notes : null,
    );
    const pricePreview = this.pricingService.buildPricePreview({
      baseProductionCharge: configuration.snapshot.baseProductionCharge,
      fabricCostPerYard: configuration.snapshot.fabricCostPerYard,
      rushEnabled: configuration.snapshot.rushEnabled,
      rushFee: configuration.snapshot.rushFee,
      baseYardsOverride: snapshotYardProfile?.averageBaseYards,
      additionalYards: this.resolveAdditionalYardsFromProfile(
        snapshotYardProfile,
        intentSnapshot.chartLock.computedSize,
      ),
      rules: this.pricingService.validateConfigurationRules(
        (configuration.snapshot.rules ?? []).map((rule: Record<string, unknown>) => ({
          priority: Number(rule.priority),
          outputYards: String(rule.outputYards),
          isFallback: Boolean(rule.isFallback),
          conditionsJson: this.conditionsFromSnapshot(rule.conditions),
        })),
      ),
      requiredMeasurementKeys,
      measurementValues: submittedMeasurementValues,
      rushSelected: intentSnapshot.rushSelected,
      shippingAddress: intentSnapshot.shippingAddress ?? undefined,
      currency: configuration.configuration.brand.currency,
    });
    const requiredMeasurementSnapshot = requiredMeasurementKeys.reduce<Record<string, number>>(
      (accumulator, key) => {
        const value = Number(submittedMeasurementValues[key]);
        if (Number.isFinite(value)) {
          accumulator[key] = value;
        }
        return accumulator;
      },
      {},
    );
    const sourceSnapshot = await this.resolveSourceSnapshot(
      configuration.configuration.sourceType,
      configuration.configuration.sourceId,
    );
    const retainedUntil = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const acceptedAt = params.confirmedAt ?? new Date();
    const promisedProductionAt = new Date(
      acceptedAt.getTime() + configuration.snapshot.productionLeadDays * 24 * 60 * 60 * 1000,
    );
    const promisedDispatchAt = promisedProductionAt;
    const promisedDeliveryAt = new Date(
      promisedDispatchAt.getTime() + configuration.snapshot.deliveryMaxDays * 24 * 60 * 60 * 1000,
    );

    return {
      brandId: configuration.configuration.brandId,
      buyerId: params.buyerId,
      sourceType: configuration.configuration.sourceType,
      sourceId: configuration.configuration.sourceId,
      sourceTitleSnapshot: sourceSnapshot.title,
      sourceSlugSnapshot: sourceSnapshot.slug,
      sourcePrimaryMediaUrlSnapshot: sourceSnapshot.primaryMediaUrl,
      sourceBrandNameSnapshot: sourceSnapshot.brandName,
      configurationId: configuration.configuration.id,
      configurationVersionId: configuration.version.id,
      status: CustomOrderStatus.ACCEPTED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: params.paymentMethod,
      paymentReference: params.paymentReference,
      currency: configuration.configuration.brand.currency,
      checkoutIntentId: params.intent.id,
      baseProductionChargeSnapshot: new Prisma.Decimal(configuration.snapshot.baseProductionCharge),
      fabricCostPerYardSnapshot: new Prisma.Decimal(configuration.snapshot.fabricCostPerYard),
      computedYards: new Prisma.Decimal(pricePreview.computedYards),
      matchedFabricRuleId:
        typeof intentSnapshot.matchedFabricRuleId === 'string'
          ? intentSnapshot.matchedFabricRuleId
          : null,
      internalPriceBreakdownJson: {
        ...pricePreview.internalPriceBreakdown,
        chartLock: intentSnapshot.chartLock,
        noDirectMatchAcknowledged: submissionMeta.noDirectMatchAcknowledged,
        requiredMeasurementSnapshot,
        measurementAttachmentMeta: {
          attachedAt: new Date().toISOString(),
          requiredMeasurementKeys,
          requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
        },
      } as Prisma.InputJsonValue,
      buyerPriceSummaryJson: params.intent.buyerPriceSummaryJson,
      measurementSnapshotJson: submittedMeasurementValues as Prisma.InputJsonValue,
      measurementConfirmedAt: submissionMeta.submittedAt
        ? new Date(submissionMeta.submittedAt)
        : acceptedAt,
      rushSelected: intentSnapshot.rushSelected,
      rushFeeSnapshot: configuration.snapshot.rushFee
        ? new Prisma.Decimal(configuration.snapshot.rushFee)
        : null,
      productionLeadDaysSnapshot: configuration.snapshot.productionLeadDays,
      deliveryMinDaysSnapshot: configuration.snapshot.deliveryMinDays,
      deliveryMaxDaysSnapshot: configuration.snapshot.deliveryMaxDays,
      shippingAddressJson: intentSnapshot.shippingAddress as Prisma.InputJsonValue,
      contactInfoJson: {
        ...submissionMeta.contactInfo,
        customerName: submissionMeta.customerName,
      } as Prisma.InputJsonValue,
      idempotencyKey: submissionMeta.submissionIdempotencyKey,
      measurementRetentionUntil: retainedUntil,
      acceptedAt,
      promisedProductionAt,
      promisedDispatchAt,
      promisedDeliveryAt,
      currentProgressStage: CustomOrderProgressStage.ORDER_RECEIVED,
      currentProgressStageEnteredAt: acceptedAt,
      lastBrandProgressUpdateAt: acceptedAt,
      timelineEvents: {
        create: [
          {
            actorType: CustomOrderActorType.SYSTEM,
            eventType: 'CONFIGURATION_VERSION_LOCKED',
            payloadJson: {
              configurationId: configuration.configuration.id,
              configurationVersionId: configuration.version.id,
              checkoutIntentId: params.intent.id,
              chartVersionId: intentSnapshot.chartLock.chartVersionId,
              pricingChartFamily: intentSnapshot.chartLock.pricingChartFamily,
              displayChartFamily: intentSnapshot.chartLock.displayChartFamily,
              resolverPolicy: intentSnapshot.chartLock.resolverPolicy,
              computedSize: intentSnapshot.chartLock.computedSize,
              noDirectMatch: intentSnapshot.chartLock.noDirectMatch,
            },
          },
          {
            actorType: CustomOrderActorType.BUYER,
            actorId: params.buyerId,
            eventType: 'ORDER_CREATED',
            payloadJson: {
              checkoutIntentId: params.intent.id,
              customerName: submissionMeta.customerName,
              requiredMeasurementKeys,
              requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
            },
          },
        ],
      },
    } satisfies Prisma.CustomOrderUncheckedCreateInput;
  }

  async listBuyerOrders(userId: string, query: QueryCustomOrdersDto) {
    // Include PENDING_PAYMENT orders so that legacy orders created before the
    // payment-first refactor remain visible and retriable by buyers.  In the
    // current flow CustomOrder rows are only materialised after payment (ACCEPTED
    // status), so PENDING_PAYMENT records are exclusively legacy rows.
    return this.listOrders(
      { buyerId: userId },
      query,
    );
  }

  async getBuyerOrder(userId: string, customOrderId: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    const hydratedOrder = await this.hydrateSingleOrderSourceSnapshot(order);

    return {
      statusCode: 200,
      message: 'Custom order retrieved',
      data: this.mapDetail(hydratedOrder),
    };
  }

  async getCheckoutSession(userId: string, sessionId: string) {
    const session = await this.prisma.customOrderCheckoutSession.findFirst({
      where: { id: sessionId, buyerId: userId },
      select: {
        id: true,
        status: true,
        checkoutIntentId: true,
        customOrderId: true,
        submittedAt: true,
        paymentInitiatedAt: true,
        paidConfirmedAt: true,
        abandonedAt: true,
        lastAttemptReference: true,
        lastAttemptStatus: true,
        attemptsCount: true,
        resumeToken: true,
        resumePath: true,
        uiStateJson: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Custom order checkout session not found');
    }

    return {
      statusCode: 200,
      message: 'Custom order checkout session retrieved',
      data: this.mapCheckoutSession(session),
    };
  }

  async getCheckoutSessionByToken(userId: string, token: string) {
    const session = await this.prisma.customOrderCheckoutSession.findFirst({
      where: { resumeToken: token, buyerId: userId },
      select: {
        id: true,
        status: true,
        checkoutIntentId: true,
        customOrderId: true,
        submittedAt: true,
        paymentInitiatedAt: true,
        paidConfirmedAt: true,
        abandonedAt: true,
        lastAttemptReference: true,
        lastAttemptStatus: true,
        attemptsCount: true,
        resumeToken: true,
        resumePath: true,
        uiStateJson: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Custom order checkout session not found');
    }

    return {
      statusCode: 200,
      message: 'Custom order checkout session retrieved',
      data: this.mapCheckoutSession(session),
    };
  }

  async cancelBuyerOrder(userId: string, customOrderId: string, dto: CancelCustomOrderDto) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    if (
      ![
        CustomOrderStatus.DRAFT,
        CustomOrderStatus.PENDING_PAYMENT,
        CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      ].includes(order.status as 'DRAFT' | 'PENDING_PAYMENT' | 'PENDING_BRAND_ACCEPTANCE')
    ) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const cancellationWindowMs = Math.max(
      0,
      parseInt(process.env.CUSTOM_ORDER_CANCEL_WINDOW_MS || '', 10) || 30 * 60 * 1000,
    );
    if (
      order.status === CustomOrderStatus.PENDING_BRAND_ACCEPTANCE &&
      order.createdAt &&
      Date.now() - new Date(order.createdAt).getTime() > cancellationWindowMs
    ) {
      throw new BadRequestException(
        'CUSTOM_ORDER_CANCELLATION_WINDOW_EXPIRED: You can only cancel within 30 minutes of placing the order',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const paidPreAcceptance = order.paymentStatus === PaymentStatus.PAID;

      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
          timelineEvents: {
            create: paidPreAcceptance
              ? [
                  {
                    actorType: CustomOrderActorType.BUYER,
                    actorId: userId,
                    eventType: CustomOrderTimelineEventType.BUYER_CANCELLED,
                    payloadJson: { reason: dto.reason, cancellationType: 'BUYER_PRE_ACCEPTANCE' },
                  },
                  {
                    actorType: CustomOrderActorType.SYSTEM,
                    eventType: 'REFUND_INITIATED',
                    payloadJson: {
                      reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
                    },
                  },
                ]
              : {
                  actorType: CustomOrderActorType.BUYER,
                  actorId: userId,
                  eventType: CustomOrderTimelineEventType.BUYER_CANCELLED,
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
            status: CustomOrderLedgerAllocationStatus.REVERSED,
            reversedAt: new Date(),
            reversalReason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
          },
        });

        await this.refundService.initiateRefund(tx, {
          customOrderId,
          reason: 'BUYER_CANCELLED_PRE_ACCEPTANCE',
          actorType: CustomOrderActorType.BUYER,
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

  async confirmDelivery(
    userId: string,
    customOrderId: string,
    dto: ConfirmCustomOrderDeliveryDto,
  ) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    if (order.status !== CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const confirmedAt = new Date();
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.COMPLETED,
          buyerAcceptedAt: confirmedAt,
          completedAt: confirmedAt,
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BUYER,
              actorId: userId,
              eventType: 'BUYER_CONFIRMED_DELIVERY',
              payloadJson: dto.note ? { note: dto.note } : Prisma.JsonNull,
            },
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: confirmedAt,
        },
      });

      const finalAllocation = await tx.customOrderLedgerAllocation.findFirst({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
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

  async reportIssue(userId: string, customOrderId: string, dto: ReportCustomOrderIssueDto) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    const now = new Date();
    const disputeEligibleStates = new Set<CustomOrderStatus>([
      CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
      CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
    ]);
    if (!disputeEligibleStates.has(order.status)) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_WINDOW_CLOSED');
    }

    const normalizedEvidence = this.validateAndNormalizeIssueEvidence(dto.evidenceJson);
    const disputeIntakeQuestions = this.buildDisputeIntakeQuestions(dto.issueType);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderIssue.create({
        data: {
          customOrderId,
          issueType: dto.issueType,
          description: dto.description.trim(),
          evidenceJson: normalizedEvidence as Prisma.InputJsonValue,
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
          status: CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
          issueReportedAt: now,
          timelineEvents: {
            create: [
              {
                actorType: CustomOrderActorType.BUYER,
                actorId: userId,
                eventType: 'DELIVERY_ISSUE_REPORTED',
                payloadJson: {
                  issueType: dto.issueType,
                },
              },
              {
                actorType: CustomOrderActorType.SYSTEM,
                eventType: 'DISPUTE_CREATED',
                payloadJson: {
                  issueType: dto.issueType,
                  intakeQuestions: disputeIntakeQuestions,
                  intakeEvidenceProvided: {
                    hasText: true,
                    photoCount: (normalizedEvidence.photos as unknown[]).length,
                    optionalFileCount: ((normalizedEvidence.files as unknown[]) ?? []).length,
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
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: { in: [CustomOrderLedgerAllocationStatus.HELD, CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE] },
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.FORFEITED,
        },
      });

      return next;
    });

    await this.queueBrandNotification(
      order.brandId,
      'CUSTOM_ORDER_ISSUE_REPORTED' as NotificationType,
      customOrderId,
      { issueType: dto.issueType },
      userId,
    );
    await this.queueBuyerNotification(
      userId,
      'CUSTOM_ORDER_DISPUTE_CREATED' as NotificationType,
      customOrderId,
      { reasonType: dto.issueType },
    );

    return {
      statusCode: 200,
      message: 'Custom order issue reported',
      data: this.mapDetail(updated),
    };
  }

  async respondToExtension(
    userId: string,
    customOrderId: string,
    requestId: string,
    dto: RespondToCustomOrderExtensionDto,
  ) {
    const order = await this.requireBuyerOrder(userId, customOrderId);
    const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
    if (!extensionRequest) {
      throw new NotFoundException('Custom order extension request not found');
    }
    if (extensionRequest.buyerResponseStatus !== CustomOrderExtensionResponseStatus.OPEN) {
      throw new BadRequestException('Extension request is no longer open');
    }

    const response = dto.response;
    const counterDays = dto.counterDays;
    if (response === CustomOrderExtensionResponseStatus.COUNTERED && !counterDays) {
      throw new BadRequestException('Counter response requires a counter day value');
    }
    if (response === CustomOrderExtensionResponseStatus.COUNTERED) {
      const existingCounter = order.extensionRequests.some(
        (entry) =>
          entry.id !== requestId &&
          (entry.buyerCounterDays != null ||
            entry.buyerResponseStatus === CustomOrderExtensionResponseStatus.COUNTERED),
      );
      if (existingCounter) {
        throw new BadRequestException('Only one extension counter is allowed per order');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderExtensionRequest.update({
        where: { id: requestId },
        data: {
          buyerResponseStatus: response,
          buyerCounterDays:
            response === CustomOrderExtensionResponseStatus.COUNTERED ? counterDays : null,
          resolvedAt:
            response === CustomOrderExtensionResponseStatus.ACCEPTED ||
            response === CustomOrderExtensionResponseStatus.REJECTED
              ? new Date()
              : null,
        },
      });

      if (response === CustomOrderExtensionResponseStatus.ACCEPTED) {
        await this.applyExtensionDays(tx, order.id, extensionRequest.requestedExtraDays, extensionRequest.targetType);
      }

      if (response === CustomOrderExtensionResponseStatus.REJECTED) {
        await tx.customOrderDispute.create({
          data: {
            customOrderId,
            openedById: userId,
            reasonType: CustomOrderIssueType.UNREASONABLE_DELAY,
            buyerStatement: 'Buyer rejected brand extension request',
          },
        });

        await tx.customOrder.update({
          where: { id: customOrderId },
          data: { status: CustomOrderStatus.DISPUTED },
        });
      }

      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BUYER,
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

  async respondToBuyerCounter(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    requestId: string,
    dto: BrandRespondToCustomOrderExtensionCounterDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const extensionRequest = order.extensionRequests.find((entry) => entry.id === requestId);
    if (!extensionRequest) {
      throw new NotFoundException('Custom order extension request not found');
    }
    if (extensionRequest.buyerResponseStatus !== CustomOrderExtensionResponseStatus.COUNTERED) {
      throw new BadRequestException('Extension request is not awaiting brand response');
    }
    if (!extensionRequest.buyerCounterDays) {
      throw new BadRequestException('Countered extension request is missing buyer counter days');
    }
    if (
      dto.response !== CustomOrderExtensionResponseStatus.ACCEPTED &&
      dto.response !== CustomOrderExtensionResponseStatus.REJECTED
    ) {
      throw new BadRequestException('Brand response must accept or reject the buyer counter');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderExtensionRequest.update({
        where: { id: requestId },
        data: {
          buyerResponseStatus: dto.response,
          resolvedAt: new Date(),
        },
      });

      if (dto.response === CustomOrderExtensionResponseStatus.ACCEPTED) {
        await this.applyExtensionDays(
          tx,
          order.id,
          extensionRequest.buyerCounterDays,
          extensionRequest.targetType,
        );
      }

      return tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BRAND,
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

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_EXTENSION_RESOLVED' as NotificationType,
      customOrderId,
      {
        response: dto.response,
        counterDays: extensionRequest.buyerCounterDays,
      },
      ownerUserId,
    );

    return {
      statusCode: 200,
      message: 'Buyer counter response recorded',
      data: this.mapDetail(updated),
    };
  }

  async getDisplayChartPreference(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationSettings: true },
    });
    const settings = user?.notificationSettings as Record<string, unknown> | null;
    const customOrders = settings?.customOrders as Record<string, unknown> | undefined;
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

  async updateDisplayChartPreference(userId: string, dto: UpdateDisplayChartPreferenceDto) {
    const displayChartFamily = this.normalizeChartFamily(dto.displayChartFamily);
    const updatedAtMs = dto.updatedAtMs ?? Date.now();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationSettings: true },
    });
    const existing = (user?.notificationSettings as Record<string, unknown> | null) ?? {};
    const next = {
      ...existing,
      customOrders: {
        ...((existing.customOrders as Record<string, unknown>) ?? {}),
        displayChartFamily,
        displayChartUpdatedAtMs: updatedAtMs,
      },
    };

    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationSettings: next as Prisma.InputJsonValue },
    });

    return {
      statusCode: 200,
      message: 'Display chart preference updated',
      data: { displayChartFamily, updatedAtMs },
    };
  }

  async createExceptionReviewRequest(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: CreateExceptionReviewRequestDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    const exceptionReviewEligibleStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
      CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
    ]);
    if (!exceptionReviewEligibleStatuses.has(order.status)) {
      throw new BadRequestException('EXCEPTION_REVIEW_NOT_ALLOWED_FOR_STATE');
    }

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const monthCount = await this.prisma.customOrderTimelineEvent.count({
      where: {
        eventType: 'ADMIN_ESCALATED',
        actorType: CustomOrderActorType.BRAND,
        actorId: ownerUserId,
        createdAt: { gte: monthStart },
      },
    });
    if (monthCount >= EXCEPTION_REVIEW_MONTHLY_QUOTA) {
      throw new BadRequestException('EXCEPTION_REVIEW_MONTHLY_QUOTA_EXCEEDED');
    }

    const dueAt = new Date(Date.now() + EXCEPTION_REVIEW_SLA_HOURS * 60 * 60 * 1000);
    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BRAND,
            actorId: ownerUserId,
            eventType: 'ADMIN_ESCALATED',
            payloadJson: {
              kind: 'EXCEPTION_REVIEW_REQUEST',
              status: 'NEW',
              requestedQuoteTotal: dto.requestedQuoteTotal ?? null,
              reason: dto.reason.trim(),
              dueAt: dueAt.toISOString(),
                chartLock: this.normalizeChartLock(
                  (order.internalPriceBreakdownJson as Record<string, unknown>)?.chartLock,
                ) as Prisma.InputJsonValue,
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

  async listBrandOrders(ownerUserId: string, brandId: string, query: QueryCustomOrdersDto) {
    const brand = await this.resolveBrand(ownerUserId);
    if (brand.id !== brandId) {
      throw new ForbiddenException('Not authorized for this brand');
    }
    // Include PENDING_PAYMENT orders so that legacy pre-refactor orders remain
    // visible to brands.  New orders skip PENDING_PAYMENT entirely (created
    // directly in ACCEPTED after payment confirmation).
    return this.listOrders(
      { brandId },
      query,
    );
  }

  async getBrandOrder(ownerUserId: string, brandId: string, customOrderId: string) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    const hydratedOrder = await this.hydrateSingleOrderSourceSnapshot(order);

    return {
      statusCode: 200,
      message: 'Custom order retrieved',
      data: this.mapDetail(hydratedOrder),
    };
  }

  async acceptBrandOrder(ownerUserId: string, brandId: string, customOrderId: string, dto: AcceptCustomOrderDto) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.status === CustomOrderStatus.ACCEPTED || order.status === CustomOrderStatus.IN_PRODUCTION) {
      return {
        statusCode: 200,
        message: 'Custom order already accepted',
        data: this.mapDetail(order),
      };
    }
    if (order.status !== CustomOrderStatus.PENDING_BRAND_ACCEPTANCE || order.paymentStatus !== 'PAID') {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const now = new Date();
    const promisedProductionAt = new Date(now.getTime() + order.productionLeadDaysSnapshot * 24 * 60 * 60 * 1000);
    const promisedDispatchAt = promisedProductionAt;
    const promisedDeliveryAt = new Date(
      promisedDispatchAt.getTime() + order.deliveryMaxDaysSnapshot * 24 * 60 * 60 * 1000,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.ACCEPTED,
          acceptedAt: now,
          promisedProductionAt,
          promisedDispatchAt,
          promisedDeliveryAt,
          currentProgressStage: CustomOrderProgressStage.ORDER_RECEIVED,
          currentProgressStageEnteredAt: now,
          lastBrandProgressUpdateAt: now,
          progressEvents: {
            create: {
              stage: CustomOrderProgressStage.ORDER_RECEIVED,
              note: dto.note?.trim() || null,
              changedById: ownerUserId,
              staleThresholdAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
          },
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.BRAND,
              actorId: ownerUserId,
              eventType: 'BRAND_ACCEPTED',
              payloadJson: dto.note ? { note: dto.note } : Prisma.JsonNull,
            },
          },
        },
        include: this.detailIncludes,
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId,
          allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: now,
        },
      });

      return next;
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_BRAND_ACCEPTED' as NotificationType,
      customOrderId,
      { brandName: order.sourceBrandNameSnapshot },
      ownerUserId,
    );

    return {
      statusCode: 200,
      message: 'Custom order accepted',
      data: this.mapDetail(updated),
    };
  }

  async rejectBrandOrder(ownerUserId: string, brandId: string, customOrderId: string, dto: RejectCustomOrderDto) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.status === CustomOrderStatus.REJECTED_BY_BRAND) {
      return {
        statusCode: 200,
        message: 'Custom order already rejected',
        data: this.mapDetail(order),
      };
    }
    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new ForbiddenException(
        'Paid custom orders are auto-accepted. Only a super admin can cancel the order and trigger a full refund.',
      );
    }
    if (order.status !== CustomOrderStatus.PENDING_BRAND_ACCEPTANCE) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          status: CustomOrderStatus.REJECTED_BY_BRAND,
          rejectedAt: new Date(),
          timelineEvents: {
            create: [
              {
                actorType: CustomOrderActorType.BRAND,
                actorId: ownerUserId,
                eventType: 'BRAND_REJECTED',
                payloadJson: { reason: dto.reason },
              },
              {
                actorType: CustomOrderActorType.SYSTEM,
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
          status: CustomOrderLedgerAllocationStatus.REVERSED,
          reversedAt: new Date(),
          reversalReason: 'BRAND_REJECTED',
        },
      });

      await this.refundService.initiateRefund(tx, {
        customOrderId,
        reason: 'BRAND_REJECTED',
        actorType: CustomOrderActorType.BRAND,
        actorId: ownerUserId,
      });

      return next;
    });

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_BRAND_REJECTED' as NotificationType,
      customOrderId,
      { reason: dto.reason },
      ownerUserId,
    );

    return {
      statusCode: 200,
      message: 'Custom order rejected',
      data: this.mapDetail(updated),
    };
  }

  async updateBrandProgressStage(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: UpdateCustomOrderProgressStageDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    const preAcceptanceStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.DRAFT,
      CustomOrderStatus.PENDING_PAYMENT,
      CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
    ]);
    const productionStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
    ]);
    const brandManagedStages = new Set<CustomOrderProgressStage>([
      CustomOrderProgressStage.FABRIC_AND_PIECE_PURCHASE_GATHERING,
      CustomOrderProgressStage.DESIGN_MODE,
      CustomOrderProgressStage.FINAL_TOUCHES_AND_PACKAGING,
      CustomOrderProgressStage.READY_FOR_DELIVERY,
    ]);

    if (!preAcceptanceStatuses.has(order.status) && !productionStatuses.has(order.status)) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE');
    }
    if (!brandManagedStages.has(dto.stage)) {
      throw new BadRequestException(
        'ORDER_PLACED and ORDER_RECEIVED are system-managed. Brand updates begin at fabric and piece gathering.',
      );
    }

    const now = new Date();
    const nextStatus =
      dto.stage === CustomOrderProgressStage.READY_FOR_DELIVERY
        ? CustomOrderStatus.READY_FOR_DISPATCH
        : CustomOrderStatus.IN_PRODUCTION;

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
            actorType: CustomOrderActorType.BRAND,
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

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_PROGRESS_UPDATED' as NotificationType,
      customOrderId,
      { stage: dto.stage, note: dto.note ?? null },
      ownerUserId,
    );

    return {
      statusCode: 200,
      message: 'Custom order progress stage updated',
      data: this.mapDetail(updated),
    };
  }

  async createExtensionRequest(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: CreateCustomOrderExtensionRequestDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    if (order.extensionRequests.length > 0) {
      throw new BadRequestException('Only one extension request is allowed per order');
    }
    if (!this.isExtensionRequestAllowed(order.status, dto.targetType)) {
      throw new BadRequestException('CUSTOM_ORDER_EXTENSION_NOT_ALLOWED_FOR_STATE');
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
            actorType: CustomOrderActorType.BRAND,
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

    await this.queueBuyerNotification(
      order.buyerId,
      'CUSTOM_ORDER_EXTENSION_REQUESTED' as NotificationType,
      customOrderId,
      {
        requestedExtraDays: dto.requestedExtraDays,
        targetType: dto.targetType,
      },
      ownerUserId,
    );

    return {
      statusCode: 201,
      message: 'Custom order extension request created',
      data: this.mapDetail(updated),
    };
  }

  async updateLifecycleStatus(
    ownerUserId: string,
    brandId: string,
    customOrderId: string,
    dto: UpdateCustomOrderLifecycleStatusDto,
  ) {
    await this.assertBrandOwnership(ownerUserId, brandId);
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, brandId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const allowedStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
      CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      CustomOrderStatus.CLOSED,
    ]);
    if (!allowedStatuses.has(dto.status)) {
      throw new BadRequestException('Unsupported custom-order lifecycle transition');
    }
    if (!this.isLifecycleTransitionAllowed(order.status, dto.status)) {
      throw new BadRequestException('CUSTOM_ORDER_INVALID_STATE_TRANSITION');
    }

    const now = new Date();
    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        status: dto.status,
        lastBrandProgressUpdateAt: now,
        deliveredAt:
          dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION ? now : order.deliveredAt,
        buyerAcceptanceWindowEndsAt:
          dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
            ? new Date(now.getTime() + BUYER_ACCEPTANCE_WINDOW_HOURS * 60 * 60 * 1000)
            : order.buyerAcceptanceWindowEndsAt,
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BRAND,
            actorId: ownerUserId,
            eventType:
              dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION
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

    if (dto.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION) {
      await this.queueBuyerNotification(
        order.buyerId,
        'CUSTOM_ORDER_DELIVERED' as NotificationType,
        customOrderId,
        {},
        ownerUserId,
      );
    }

    return {
      statusCode: 200,
      message: 'Custom order lifecycle status updated',
      data: this.mapDetail(updated),
    };
  }

  async updateBuyerMeasurementsBeforeAcceptance(
    userId: string,
    customOrderId: string,
    dto: UpdateCustomOrderMeasurementsDto,
  ) {
    const submittedMeasurementValues = this.normalizeMeasurementValues(dto.measurementValues);
    const order = await this.requireBuyerOrder(userId, customOrderId);
    const measurementUpdateWindowOpen =
      order.paymentStatus === PaymentStatus.PAID &&
      (
        order.status === CustomOrderStatus.PENDING_BRAND_ACCEPTANCE ||
        (
          order.status === CustomOrderStatus.ACCEPTED &&
          order.currentProgressStage === CustomOrderProgressStage.ORDER_RECEIVED
        )
      );

    if (!measurementUpdateWindowOpen) {
      throw new BadRequestException('CUSTOM_ORDER_MEASUREMENT_UPDATE_WINDOW_CLOSED');
    }

    const configuration = await this.getConfigurationVersion(order.configurationId, order.configurationVersionId);
    const requiredMeasurementKeys = await this.resolveRequiredMeasurementKeys(
      configuration.snapshot.requiredMeasurementKeys ?? [],
      configuration.snapshot.requiredFreeformPointIds ?? [],
    );
    await this.validateMeasurementRanges(requiredMeasurementKeys, submittedMeasurementValues);

    const yardProfile = this.parseConfigurationYardProfile(
      typeof configuration.snapshot.notes === 'string' ? configuration.snapshot.notes : null,
    );
    const chartLock = this.normalizeChartLock(
      (order.internalPriceBreakdownJson as Record<string, unknown>)?.chartLock,
    );

    const revalidatedPreview = this.pricingService.buildPricePreview({
      baseProductionCharge: configuration.snapshot.baseProductionCharge,
      fabricCostPerYard: configuration.snapshot.fabricCostPerYard,
      rushEnabled: configuration.snapshot.rushEnabled,
      rushFee: configuration.snapshot.rushFee,
      baseYardsOverride: yardProfile?.averageBaseYards,
      additionalYards: this.resolveAdditionalYardsFromProfile(yardProfile, chartLock.computedSize),
      rules: this.pricingService.validateConfigurationRules(
        (configuration.snapshot.rules ?? []).map((rule: Record<string, unknown>) => ({
          priority: Number(rule.priority),
          outputYards: String(rule.outputYards),
          isFallback: Boolean(rule.isFallback),
          conditionsJson: this.conditionsFromSnapshot(rule.conditions),
        })),
      ),
      requiredMeasurementKeys,
      measurementValues: submittedMeasurementValues,
      rushSelected: order.rushSelected,
      shippingAddress: (order.shippingAddressJson as Record<string, unknown> | null) ?? undefined,
      currency: order.currency,
    });

    const existingGrandTotal = Number(
      (order.buyerPriceSummaryJson as Record<string, unknown>)?.grandTotal ?? 0,
    );
    const revalidatedGrandTotal = Number(revalidatedPreview.buyerPriceSummary.grandTotal ?? 0);
    if (existingGrandTotal !== revalidatedGrandTotal) {
      throw new BadRequestException(
        'Measurement update changes the locked payable total. Please create a new preview and contact support/admin for settlement revalidation.',
      );
    }

    const requiredMeasurementSnapshot = requiredMeasurementKeys.reduce<Record<string, number>>(
      (accumulator, key) => {
        const value = Number(submittedMeasurementValues[key]);
        if (Number.isFinite(value)) {
          accumulator[key] = value;
        }
        return accumulator;
      },
      {},
    );

    const updated = await this.prisma.customOrder.update({
      where: { id: customOrderId },
      data: {
        measurementSnapshotJson: submittedMeasurementValues as Prisma.InputJsonValue,
        measurementConfirmedAt: new Date(),
        internalPriceBreakdownJson: {
          ...(order.internalPriceBreakdownJson as Record<string, unknown>),
          requiredMeasurementSnapshot,
          measurementAttachmentMeta: {
            attachedAt: new Date().toISOString(),
            requiredMeasurementKeys,
            requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
            updatedBeforeAcceptance: true,
            updateReason: dto.reason ?? null,
          },
        } as Prisma.InputJsonValue,
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.BUYER,
            actorId: userId,
            eventType: 'PRICE_PREVIEW_CREATED',
            payloadJson: {
              action: 'MEASUREMENTS_UPDATED_PRE_PRODUCTION',
              phase: 'PRE_PRODUCTION',
              reason: dto.reason ?? null,
              requiredMeasurementKeys,
              requiredMeasurementCount: Object.keys(requiredMeasurementSnapshot).length,
            },
          },
        },
      },
      include: this.detailIncludes,
    });

    await this.queueBrandNotification(
      order.brandId,
      'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType,
      customOrderId,
      {
        reason: 'MEASUREMENTS_UPDATED_PRE_PRODUCTION',
      },
      userId,
    );

    return {
      statusCode: 200,
      message: 'Custom order measurements updated and revalidated',
      data: this.mapDetail(updated),
    };
  }

  private async queueBuyerNotification(
    recipientId: string,
    notificationType: NotificationType,
    customOrderId: string,
    payload: Record<string, unknown> = {},
    actorId?: string | null,
  ) {
    await this.sideEffects.enqueueNotification({
      customOrderId,
      recipientIds: [recipientId],
      notificationType,
      actorId: actorId ?? null,
      payload: {
        customOrderId,
        targetUrl: `/custom-orders/${customOrderId}`,
        ...payload,
      },
      dedupeMs: 5 * 60 * 1000,
    });
  }

  private async queueBrandNotification(
    brandId: string,
    notificationType: NotificationType,
    customOrderId: string,
    payload: Record<string, unknown> = {},
    actorId?: string | null,
  ) {
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
      actorId: actorId ?? null,
      payload: {
        customOrderId,
        targetUrl: `/studio/custom-orders/${customOrderId}`,
        ...payload,
      },
      dedupeMs: 5 * 60 * 1000,
    });
  }

  private async resolveUserDisplayName(userId: string, fallback?: string | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, firstName: true, lastName: true },
    });

    const fullName = [user?.firstName, user?.lastName]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .trim();

    return (
      user?.username?.trim() ||
      fullName ||
      fallback?.trim() ||
      'there'
    );
  }

  private async listOrders(
    where: Prisma.CustomOrderWhereInput,
    query: QueryCustomOrdersDto,
  ) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const searchQuery = query.q?.trim();
    const finalWhere: Prisma.CustomOrderWhereInput = {
      ...where,
      ...(query.status ? { status: query.status } : {}),
      ...(query.stage ? { currentProgressStage: query.stage } : {}),
      ...(searchQuery
        ? {
            OR: [
              ...(isUuid(searchQuery) ? [{ id: { equals: searchQuery } }] : []),
              { sourceTitleSnapshot: { contains: searchQuery, mode: 'insensitive' } },
              { sourceBrandNameSnapshot: { contains: searchQuery, mode: 'insensitive' } },
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

    const hydratedItems = await this.hydrateListOrderSnapshots(items);
    const visibleItems = this.collapseVisibleDuplicateOrders(hydratedItems);

    return {
      statusCode: 200,
      message: 'Custom orders retrieved',
      data: {
        items: visibleItems.map((item) => this.mapListItem(item)),
        page,
        limit: take,
        total,
      },
    };
  }

  private async hydrateListOrderSnapshots(
    items: Prisma.CustomOrderGetPayload<{}>[],
  ): Promise<Prisma.CustomOrderGetPayload<{}>[]> {
    const productIdsNeedingMedia = Array.from(
      new Set(
        items
          .filter(
              (item) =>
                item.sourceType === CustomOrderSourceType.PRODUCT &&
                hasEphemeralMediaSignature(item.sourcePrimaryMediaUrlSnapshot),
            )
            .map((item) => item.sourceId),
        ),
      );
    const designIdsNeedingMedia = Array.from(
      new Set(
        items
          .filter(
              (item) =>
                item.sourceType === CustomOrderSourceType.DESIGN &&
                hasEphemeralMediaSignature(item.sourcePrimaryMediaUrlSnapshot),
            )
            .map((item) => item.sourceId),
        ),
      );

    const [products, designs] = await Promise.all([
      productIdsNeedingMedia.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIdsNeedingMedia } },
            select: {
              id: true,
              name: true,
              thumbnail: true,
              images: true,
              brand: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      designIdsNeedingMedia.length
        ? this.prisma.collection.findMany({
            where: { id: { in: designIdsNeedingMedia } },
            select: {
              id: true,
              title: true,
              owner: { select: { brand: { select: { name: true } } } },
              coverMedia: { select: { file: { select: { s3Url: true } } } },
              medias: {
                take: 1,
                orderBy: { orderIndex: 'asc' },
                select: { file: { select: { s3Url: true } } },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const productById = new Map(
      products.map((product) => [
        product.id,
        {
          title: product.name,
          brandName: product.brand.name,
          mediaUrl: product.thumbnail ?? product.images[0] ?? null,
        },
      ]),
    );
    const designById = new Map(
      designs.map((design) => [
        design.id,
        {
          title: design.title ?? 'Untitled design',
          brandName: design.owner.brand?.name ?? null,
          mediaUrl: design.coverMedia?.file.s3Url ?? design.medias[0]?.file.s3Url ?? null,
        },
      ]),
    );

    return items.map((item) => {
      const needsFreshMedia = hasEphemeralMediaSignature(item.sourcePrimaryMediaUrlSnapshot);
      const hasStableIdentitySnapshot =
        Boolean(item.sourceBrandNameSnapshot) &&
        Boolean(item.sourceTitleSnapshot) &&
        Boolean(item.sourcePrimaryMediaUrlSnapshot);
      if (!needsFreshMedia && hasStableIdentitySnapshot) {
        return item;
      }

      const source =
        item.sourceType === CustomOrderSourceType.PRODUCT
          ? productById.get(item.sourceId)
          : designById.get(item.sourceId);
      if (!source) {
        return item;
      }

      return {
        ...item,
        sourceTitleSnapshot: item.sourceTitleSnapshot || source.title,
        sourceBrandNameSnapshot: item.sourceBrandNameSnapshot || source.brandName,
        sourcePrimaryMediaUrlSnapshot:
          needsFreshMedia ? source.mediaUrl : item.sourcePrimaryMediaUrlSnapshot || source.mediaUrl,
      };
    });
  }

  private async hydrateSingleOrderSourceSnapshot(
    order: Prisma.CustomOrderGetPayload<{}>,
  ): Promise<Prisma.CustomOrderGetPayload<{}>> {
    const needsFreshMedia = hasEphemeralMediaSignature(order.sourcePrimaryMediaUrlSnapshot);
    const hasStableIdentitySnapshot =
      Boolean(order.sourceBrandNameSnapshot) &&
      Boolean(order.sourceTitleSnapshot) &&
      Boolean(order.sourcePrimaryMediaUrlSnapshot);
    if (!needsFreshMedia && hasStableIdentitySnapshot) {
      return order;
    }

    const source = await this.resolveSourceSnapshot(order.sourceType, order.sourceId);
    return {
      ...order,
      sourceTitleSnapshot: order.sourceTitleSnapshot || source.title,
      sourceBrandNameSnapshot: order.sourceBrandNameSnapshot || source.brandName,
      sourcePrimaryMediaUrlSnapshot: needsFreshMedia
        ? source.primaryMediaUrl
        : order.sourcePrimaryMediaUrlSnapshot || source.primaryMediaUrl,
    };
  }

  private collapseVisibleDuplicateOrders(
    items: Prisma.CustomOrderGetPayload<{}>[],
  ): Prisma.CustomOrderGetPayload<{}>[] {
    const preAcceptanceStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.DRAFT,
      CustomOrderStatus.PENDING_PAYMENT,
      CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
    ]);
    const grouped = new Map<string, Prisma.CustomOrderGetPayload<{}>>();

    for (const item of items) {
      const shouldCollapse = preAcceptanceStatuses.has(item.status);
      const dedupeKey = shouldCollapse
        ? [
            item.buyerId,
            item.brandId,
            item.sourceType,
            item.sourceId,
            item.configurationId,
            item.rushSelected ? 'rush' : 'standard',
            stableStringify(item.measurementSnapshotJson),
            stableStringify(item.shippingAddressJson),
            stableStringify(item.contactInfoJson),
            stableStringify(item.buyerPriceSummaryJson),
          ].join('::')
        : item.id;

      const existing = grouped.get(dedupeKey);
      if (!existing) {
        grouped.set(dedupeKey, item);
        continue;
      }

      const existingScore =
        (existing.sourcePrimaryMediaUrlSnapshot ? 2 : 0) +
        (existing.updatedAt?.getTime() ?? existing.createdAt.getTime());
      const incomingScore =
        (item.sourcePrimaryMediaUrlSnapshot ? 2 : 0) +
        (item.updatedAt?.getTime() ?? item.createdAt.getTime());

      if (incomingScore > existingScore) {
        grouped.set(dedupeKey, item);
      }
    }

    return Array.from(grouped.values()).sort(
      (left, right) =>
        (right.updatedAt?.getTime() ?? right.createdAt.getTime()) -
        (left.updatedAt?.getTime() ?? left.createdAt.getTime()),
    );
  }

  private async requireBuyerOrder(userId: string, customOrderId: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id: customOrderId, buyerId: userId },
      include: this.detailIncludes,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    return order;
  }

  private async resolveBrand(ownerUserId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: ownerUserId },
      select: { id: true },
    });
    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }
    return brand;
  }

  private async assertBrandOwnership(ownerUserId: string, brandId: string) {
    const brand = await this.resolveBrand(ownerUserId);
    if (brand.id !== brandId) {
      throw new ForbiddenException('Not authorized for this brand');
    }
  }

  private async getActiveConfiguration(configurationId: string, requestedVersionId?: string) {
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
      throw new NotFoundException('Custom order configuration not found');
    }
    const version = configuration.versions[0];
    if (!version) {
      throw new NotFoundException('Custom order configuration version not found');
    }

    const normalizedMeasurementContract = await this.normalizeLegacyMeasurementContract({
      brandId: configuration.brandId,
      sourceType: configuration.sourceType,
      sourceId: configuration.sourceId,
      requiredMeasurementKeys: configuration.requiredMeasurementKeys,
      requiredFreeformPointIds: configuration.requiredFreeformPointIds,
    });

    return {
      ...configuration,
      ...normalizedMeasurementContract,
      version,
    };
  }

  private async getConfigurationVersion(configurationId: string, versionId: string) {
    const configuration = await this.prisma.customOrderConfiguration.findUnique({
      where: { id: configurationId },
      include: {
        brand: { select: { currency: true } },
        rules: { orderBy: { priority: 'asc' } },
        versions: { where: { id: versionId }, take: 1 },
      },
    });
    if (!configuration || configuration.versions.length === 0) {
      throw new NotFoundException('Custom order configuration version not found');
    }

    const version = configuration.versions[0];
    const snapshot = version.snapshotJson as Record<string, any>;
    const normalizedMeasurementContract = await this.normalizeLegacyMeasurementContract({
      brandId: configuration.brandId,
      sourceType: configuration.sourceType,
      sourceId: configuration.sourceId,
      requiredMeasurementKeys: Array.isArray(snapshot.requiredMeasurementKeys)
        ? snapshot.requiredMeasurementKeys
        : [],
      requiredFreeformPointIds: Array.isArray(snapshot.requiredFreeformPointIds)
        ? snapshot.requiredFreeformPointIds
        : [],
    });
    const normalizedSnapshot: Record<string, any> = {
      ...snapshot,
      ...normalizedMeasurementContract,
    };

    return {
      configuration,
      version,
      snapshot: normalizedSnapshot,
    };
  }

  private conditionsFromSnapshot(conditions: unknown) {
    if (!Array.isArray(conditions)) {
      return {};
    }
    return conditions.reduce<Record<string, unknown>>((accumulator, entry) => {
      const condition = entry as Record<string, unknown>;
      accumulator[String(condition.key)] = {
        min: condition.min,
        max: condition.max,
      };
      return accumulator;
    }, {});
  }

  private buildCheckoutIntentRequestSnapshot(
    measurementValues: Record<string, number>,
    rushSelected: boolean | undefined,
    shippingAddress: Record<string, unknown> | null | undefined,
    matchedFabricRuleId: string | null,
    chartLock?: CustomOrderRequestSnapshot['chartLock'],
  ): CustomOrderRequestSnapshot {
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

  private asSnapshotObject(value: Prisma.JsonValue | null | undefined) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private extractCheckoutIntentSubmissionMeta(snapshot: Prisma.JsonValue): CustomOrderSubmissionMeta {
    const value = this.asSnapshotObject(snapshot);
    const contactInfo =
      value.contactInfo && typeof value.contactInfo === 'object' && !Array.isArray(value.contactInfo)
        ? (value.contactInfo as Record<string, unknown>)
        : null;

    return {
      contactInfo,
      customerName: typeof value.customerName === 'string' ? value.customerName : null,
      submissionIdempotencyKey:
        typeof value.submissionIdempotencyKey === 'string' ? value.submissionIdempotencyKey : null,
      submittedAt: typeof value.submittedAt === 'string' ? value.submittedAt : null,
      noDirectMatchAcknowledged: Boolean(value.noDirectMatchAcknowledged),
    };
  }

  private buildCheckoutIntentSubmissionSnapshot(
    baseSnapshot: CustomOrderRequestSnapshot,
    submission: {
      contactInfo: Record<string, unknown>;
      customerName: string;
      idempotencyKey: string;
      noDirectMatchAcknowledged?: boolean;
    },
  ) {
    return {
      ...baseSnapshot,
      contactInfo: submission.contactInfo,
      customerName: submission.customerName,
      submissionIdempotencyKey: submission.idempotencyKey,
      submittedAt: new Date().toISOString(),
      noDirectMatchAcknowledged: Boolean(submission.noDirectMatchAcknowledged),
    };
  }

  private normalizeCheckoutIntentRequestSnapshot(snapshot: Prisma.JsonValue): CustomOrderRequestSnapshot {
    const value = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : {};

    return this.buildCheckoutIntentRequestSnapshot(
      (value.measurementValues as Record<string, number>) ?? {},
      Boolean(value.rushSelected),
      (value.shippingAddress as Record<string, unknown> | null | undefined) ?? null,
      typeof value.matchedFabricRuleId === 'string' ? value.matchedFabricRuleId : null,
      this.normalizeChartLock(value.chartLock),
    );
  }

  private normalizeChartLock(raw: unknown): CustomOrderRequestSnapshot['chartLock'] {
    const lock = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const pricingChartFamily = this.normalizeChartFamily(lock.pricingChartFamily);
    const displayChartFamily = this.normalizeChartFamily(lock.displayChartFamily);
    const resolverPolicy = this.normalizeResolverPolicy(lock.resolverPolicy);

    return {
      pricingChartFamily,
      displayChartFamily,
      resolverPolicy,
      chartVersionId:
        typeof lock.chartVersionId === 'string' && lock.chartVersionId.trim().length > 0
          ? lock.chartVersionId
          : this.currentChartVersionId(),
      computedSize: typeof lock.computedSize === 'string' ? lock.computedSize : null,
      noDirectMatch: Boolean(lock.noDirectMatch),
      conversionGuidance: typeof lock.conversionGuidance === 'string' ? lock.conversionGuidance : null,
      quoteStatus: lock.quoteStatus === 'MANUAL_QUOTE_REQUIRED' ? 'MANUAL_QUOTE_REQUIRED' : 'AUTO_PRICED',
    };
  }

  private generateCheckoutResumeToken(): string {
    return randomUUID();
  }

  private buildCheckoutResumeUrl(token: string): string {
    const baseUrl = resolveWebAppBaseUrl();
    return `${baseUrl}/custom-orders/resume/${encodeURIComponent(token)}`;
  }

  private mapCheckoutSession(session: {
    id: string;
    status: string;
    checkoutIntentId: string;
    customOrderId: string | null;
    submittedAt: Date;
    paymentInitiatedAt: Date | null;
    paidConfirmedAt: Date | null;
    abandonedAt: Date | null;
    lastAttemptReference: string | null;
    lastAttemptStatus: string | null;
    attemptsCount: number;
    resumeToken: string;
    resumePath: string | null;
    uiStateJson: Prisma.JsonValue | null;
  }) {
    return {
      id: session.id,
      status: session.status,
      checkoutIntentId: session.checkoutIntentId,
      customOrderId: session.customOrderId,
      submittedAt: session.submittedAt.toISOString(),
      paymentInitiatedAt: session.paymentInitiatedAt?.toISOString() ?? null,
      paidConfirmedAt: session.paidConfirmedAt?.toISOString() ?? null,
      abandonedAt: session.abandonedAt?.toISOString() ?? null,
      lastAttemptReference: session.lastAttemptReference,
      lastAttemptStatus: session.lastAttemptStatus,
      attemptsCount: session.attemptsCount,
      resumeUrl: this.buildCheckoutResumeUrl(session.resumeToken),
      resumePath: session.resumePath,
      uiState: session.uiStateJson ?? null,
    };
  }

  private normalizeChartFamily(value: unknown): CustomOrderChartFamily {
    const v = typeof value === 'string' ? value.toUpperCase() : '';
    if (
      v === 'UK' ||
      v === 'US' ||
      v === 'NIGERIA' ||
      v === 'ASIA' ||
      v === 'HYBRID_UK_NIGERIA' ||
      v === 'HYBRID_US_NIGERIA'
    ) {
      return v;
    }
    return DEFAULT_PRICING_CHART_FAMILY;
  }

  private normalizeResolverPolicy(value: unknown): CustomOrderResolverPolicy {
    const v = typeof value === 'string' ? value.toUpperCase() : '';
    if (v === 'PRIMARY_ONLY' || v === 'MAX_OF_BOTH' || v === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
      return v;
    }
    return DEFAULT_RESOLVER_POLICY;
  }

  private currentChartVersionId() {
    return `chart-pack-v2-${new Date().getUTCFullYear()}Q1`;
  }

  private validateAndNormalizeIssueEvidence(
    evidenceJson: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const normalized =
      evidenceJson && typeof evidenceJson === 'object' && !Array.isArray(evidenceJson)
        ? { ...evidenceJson }
        : {};

    const photos = Array.isArray(normalized.photos)
      ? normalized.photos.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (photos.length === 0) {
      throw new BadRequestException('Dispute evidence must include at least one photo');
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

  private buildDisputeIntakeQuestions(issueType: CustomOrderIssueType): Array<{
    key: string;
    question: string;
    required: boolean;
  }> {
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

    const issueSpecific: Record<CustomOrderIssueType, Array<{ key: string; question: string; required: boolean }>> = {
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

  private resolveAdditionalYardsFromProfile(
    profile:
      | {
          averageBaseYards?: number;
          sizeExtraYards: Array<{ sizeLabel: string; extraYards: number }>;
        }
      | null,
    computedSize?: string | null,
  ) {
    if (!computedSize) {
      return 0;
    }

    if (!profile || !Array.isArray(profile.sizeExtraYards) || profile.sizeExtraYards.length === 0) {
      return 0;
    }

    const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const target = normalize(computedSize);
    const compactTarget = normalize(computedSize.replace(/^(UK|US|NG|NIGERIA|ASIA)\s*/i, ''));

    const matched = profile.sizeExtraYards.find((row) => {
      const normalizedLabel = normalize(String(row?.sizeLabel ?? ''));
      return normalizedLabel === target || normalizedLabel === compactTarget;
    });

    return matched ? Number(matched.extraYards) || 0 : 0;
  }

  private parseConfigurationYardProfile(notes: string | null | undefined): {
    averageBaseYards?: number;
    sizeExtraYards: Array<{ sizeLabel: string; extraYards: number }>;
  } | null {
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
      const parsed = JSON.parse(jsonLine) as {
        averageBaseYards?: unknown;
        sizeExtraYards?: Array<{ sizeLabel?: unknown; extraYards?: unknown }>;
      };
      return {
        averageBaseYards:
          typeof parsed.averageBaseYards === 'number' && Number.isFinite(parsed.averageBaseYards)
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
    } catch {
      return null;
    }
  }

  private resolveChartEvaluation(input: {
    measurementValues: Record<string, number>;
    pricingChartFamily: CustomOrderChartFamily;
    displayChartFamily: CustomOrderChartFamily;
    resolverPolicy: CustomOrderResolverPolicy;
  }) {
    const required = ['BUST', 'WAIST', 'HIPS'];
    const indexed = Object.entries(input.measurementValues).reduce<Record<string, number>>((acc, [k, v]) => {
      acc[k.toUpperCase()] = Number(v);
      return acc;
    }, {});

    for (const key of required) {
      const direct = indexed[key];
      const women = indexed[`WOMEN_${key}`];
      const men =
        key === 'BUST'
          ? indexed.MEN_CHEST
          : key === 'HIPS'
            ? indexed.MEN_HIP
            : indexed[`MEN_${key}`];
      const value = Number.isFinite(direct) ? direct : Number.isFinite(women) ? women : men;
      if (!Number.isFinite(value) || value <= 0) {
        return {
          manualQuoteRequired: false,
          quoteStatus: 'AUTO_PRICED' as const,
          pricingChartFamily: input.pricingChartFamily,
          displayChartFamily: input.displayChartFamily,
          resolverPolicy: input.resolverPolicy,
          chartVersionId: this.currentChartVersionId(),
          computedSize: null,
          noDirectMatch: false,
          conversionGuidance:
            'Add bust/chest, waist, and hip measurements to compute a live size recommendation.',
        };
      }
      indexed[key] = value;
    }

    const computeFromFamily = (
      family: Exclude<CustomOrderChartFamily, 'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA'>,
    ): ComputedChartCandidate => {
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

      const nearest = bands.reduce(
        (best, band, idx) => {
          const midpoint = (band.bustMin + band.bustMax + band.waistMin + band.waistMax + band.hipsMin + band.hipsMax) / 6;
          const delta = Math.abs(midpoint - (indexed.BUST + indexed.WAIST + indexed.HIPS) / 3);
          if (delta < best.delta) {
            return { delta, idx, label: band.label };
          }
          return best;
        },
        { delta: Number.MAX_SAFE_INTEGER, idx: 0, label: bands[0].label },
      );

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
    const byFamily: Record<
      Exclude<CustomOrderChartFamily, 'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA'>,
      ComputedChartCandidate
    > = {
      UK: uk,
      NIGERIA: ng,
      US: computeFromFamily('US'),
      ASIA: computeFromFamily('ASIA'),
    };

    let chosen: ComputedChartCandidate;
    if (input.pricingChartFamily === 'HYBRID_UK_NIGERIA') {
      if (input.resolverPolicy === 'PRIMARY_ONLY') {
        chosen = uk;
      } else if (input.resolverPolicy === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
        const weighted = Math.round((uk.bandIndex * 0.6 + ng.bandIndex * 0.4));
        chosen = uk.bandIndex >= ng.bandIndex
          ? { ...uk, bandIndex: Math.max(weighted, uk.bandIndex) }
          : { ...ng, bandIndex: Math.max(weighted, ng.bandIndex) };
      } else {
        chosen = uk.bandIndex >= ng.bandIndex ? uk : ng;
      }
    } else if (input.pricingChartFamily === 'HYBRID_US_NIGERIA') {
      const us = byFamily.US;
      if (input.resolverPolicy === 'PRIMARY_ONLY') {
        chosen = us;
      } else if (input.resolverPolicy === 'WEIGHTED_AVERAGE_TO_NEAREST_BAND') {
        const weighted = Math.round((us.bandIndex * 0.6 + ng.bandIndex * 0.4));
        chosen = us.bandIndex >= ng.bandIndex
          ? { ...us, bandIndex: Math.max(weighted, us.bandIndex) }
          : { ...ng, bandIndex: Math.max(weighted, ng.bandIndex) };
      } else {
        chosen = us.bandIndex >= ng.bandIndex ? us : ng;
      }
    } else {
      chosen = byFamily[
        input.pricingChartFamily as Exclude<
          CustomOrderChartFamily,
          'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA'
        >
      ];
    }

    const displayCandidate =
      input.displayChartFamily === 'HYBRID_UK_NIGERIA' ||
      input.displayChartFamily === 'HYBRID_US_NIGERIA'
        ? chosen
        : byFamily[
            input.displayChartFamily as Exclude<
              CustomOrderChartFamily,
              'HYBRID_UK_NIGERIA' | 'HYBRID_US_NIGERIA'
            >
          ];

    return {
      manualQuoteRequired: false,
      quoteStatus: 'AUTO_PRICED' as const,
      pricingChartFamily: input.pricingChartFamily,
      displayChartFamily: input.displayChartFamily,
      resolverPolicy: input.resolverPolicy,
      chartVersionId: this.currentChartVersionId(),
      computedSize: chosen.label,
      noDirectMatch: chosen.noDirectMatch || displayCandidate.noDirectMatch,
      conversionGuidance:
        chosen.noDirectMatch || displayCandidate.noDirectMatch
          ? `Nearest mapped band: ${displayCandidate.nearestLabel ?? displayCandidate.label}`
          : null,
    };
  }

  private inferMeasurementGenderFromKeys(keys: string[]): 'MEN' | 'WOMEN' | null {
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      if (key.startsWith('MEN_')) return 'MEN';
      if (key.startsWith('WOMEN_')) return 'WOMEN';
    }
    return null;
  }

  private async resolveBaselineMeasurementKeys(gender: 'MEN' | 'WOMEN' | null) {
    const effectiveGender = gender ?? 'WOMEN';
    const orderedKeys = BASELINE_KEY_CANDIDATES[effectiveGender];

    const points = await this.prisma.measurementPoint.findMany({
      where: {
        key: { in: orderedKeys },
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
        isActive: true,
        OR: [{ gender: effectiveGender as Gender }, { gender: 'UNISEX' }, { gender: null }],
      },
      select: { key: true },
    });

    const byKey = new Set(points.map((point) => point.key));
    // Enforce baseline requirements even if seeded registry rows are not present in an environment.
    return orderedKeys.filter((key) => byKey.size === 0 || byKey.has(key));
  }

  private async resolveRequiredMeasurementKeys(
    requiredMeasurementKeys: string[],
    requiredFreeformPointIds: string[],
  ) {
    if (!requiredFreeformPointIds.length) {
      return Array.from(new Set(requiredMeasurementKeys));
    }

    const points = await this.prisma.measurementPoint.findMany({
      where: { id: { in: requiredFreeformPointIds } },
      select: { key: true },
    });

    return Array.from(
      new Set([...requiredMeasurementKeys, ...points.map((point) => point.key)]),
    );
  }

  private normalizeMeasurementKeyList(keys: string[] | null | undefined) {
    return normalizeMeasurementKeyArray(keys);
  }

  private normalizeIdList(ids: string[] | null | undefined) {
    return normalizeIdArray(ids);
  }

  private async normalizeLegacyMeasurementContract(input: {
    brandId: string;
    sourceType: CustomOrderSourceType;
    sourceId: string;
    requiredMeasurementKeys: string[];
    requiredFreeformPointIds: string[];
  }) {
    const normalizedKeys = this.normalizeMeasurementKeyList(input.requiredMeasurementKeys);
    const normalizedFreeformPointIds = this.normalizeIdList(input.requiredFreeformPointIds);

    if (normalizedKeys.length === 0) {
      return {
        requiredMeasurementKeys: normalizedKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    const sourceContract = await this.loadSourceMeasurementContract(
      input.sourceType,
      input.sourceId,
    );
    const sourceMeasurementKeys = this.normalizeMeasurementKeyList(
      sourceContract.customMeasurementKeys,
    );
    const sourceGenderHint = resolveSourceMeasurementGender({
      sourceType: input.sourceType,
      categoryTypeSlug: sourceContract.categoryTypeSlug,
      collectionType: sourceContract.collectionType,
      customGender: sourceContract.customGender ?? null,
    });

    const sourceProvidesASmallerSubset =
      sourceMeasurementKeys.length > 0 &&
      sourceMeasurementKeys.length < normalizedKeys.length &&
      sourceMeasurementKeys.every((key) => normalizedKeys.includes(key));

    if (sourceProvidesASmallerSubset) {
      return {
        requiredMeasurementKeys: sourceMeasurementKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    const registryKeys = await this.loadMeasurementPoolKeys(
      input.brandId,
      sourceGenderHint ?? sourceContract.customGender ?? null,
    );
    const LEGACY_REGISTRY_WIDTH_THRESHOLD = 8;
    const looksLikeRegistryWideLegacySelection =
      registryKeys.length >= LEGACY_REGISTRY_WIDTH_THRESHOLD &&
      registryKeys.every((key) => normalizedKeys.includes(key));
    const sourceLooksLikeRegistryWideLegacySelection =
      registryKeys.length >= LEGACY_REGISTRY_WIDTH_THRESHOLD &&
      registryKeys.every((key) => sourceMeasurementKeys.includes(key));
    const templateMeasurementKeys = resolveGarmentMeasurementTemplate(
      {
        sourceType: input.sourceType,
        categoryTypeSlug: sourceContract.categoryTypeSlug,
        collectionType: sourceContract.collectionType,
        customGender: sourceContract.customGender ?? null,
      },
      registryKeys,
    );
    const configurationContainsOppositeGenderKeys =
      sourceGenderHint != null &&
      measurementKeysContainOppositeGender(normalizedKeys, sourceGenderHint);
    const sourceContainsOppositeGenderKeys =
      sourceGenderHint != null &&
      measurementKeysContainOppositeGender(sourceMeasurementKeys, sourceGenderHint);

    if (
      templateMeasurementKeys.length > 0 &&
      templateMeasurementKeys.length < normalizedKeys.length &&
      (
        looksLikeRegistryWideLegacySelection ||
        sourceLooksLikeRegistryWideLegacySelection ||
        configurationContainsOppositeGenderKeys ||
        sourceContainsOppositeGenderKeys
      )
    ) {
      return {
        requiredMeasurementKeys: templateMeasurementKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    return {
      requiredMeasurementKeys: normalizedKeys,
      requiredFreeformPointIds: normalizedFreeformPointIds,
    };
  }

  private async loadSourceMeasurementContract(
    sourceType: CustomOrderSourceType,
    sourceId: string,
  ) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: sourceId },
        select: {
          customMeasurementKeys: true,
          customFreeformPointIds: true,
          customGender: true,
          gender: true,
          categoryType: {
            select: { slug: true },
          },
        },
      });

      if (!product) {
        throw new NotFoundException('Product source not found');
      }

      return {
        customMeasurementKeys: product.customMeasurementKeys,
        customFreeformPointIds: product.customFreeformPointIds,
        customGender: product.customGender,
        categoryTypeSlug: product.categoryType?.slug ?? null,
        collectionType: product.gender,
      };
    }

    const design = await this.prisma.collection.findUnique({
      where: { id: sourceId },
      select: {
        customMeasurementKeys: true,
        customFreeformPointIds: true,
        customGender: true,
        type: true,
        categoryType: {
          select: { slug: true },
        },
      },
    });

    if (!design) {
      throw new NotFoundException('Design source not found');
    }

    return {
      customMeasurementKeys: design.customMeasurementKeys,
      customFreeformPointIds: design.customFreeformPointIds,
      customGender: design.customGender,
      categoryTypeSlug: design.categoryType?.slug ?? null,
      collectionType: design.type,
    };
  }

  private async loadMeasurementPoolKeys(brandId: string, gender: Gender | null) {
    const points = await this.prisma.measurementPoint.findMany({
      where: {
        isActive: true,
        OR: [
          {
            source: MeasurementPointSource.SYSTEM,
            status: 'APPROVED_GLOBAL',
          },
          {
            source: MeasurementPointSource.BRAND_FREEFORM,
            brandId,
          },
        ],
        ...(gender && gender !== 'UNISEX'
          ? {
              AND: [
                {
                  OR: [{ gender }, { gender: 'UNISEX' }, { gender: null }],
                },
              ],
            }
          : {}),
      },
      select: { key: true },
    });

    return this.normalizeMeasurementKeyList(points.map((point) => point.key));
  }

  private normalizeMeasurementValues(
    measurementValues: Record<string, number> = {},
  ): Record<string, number> {
    return Object.entries(measurementValues ?? {}).reduce<Record<string, number>>(
      (accumulator, [key, value]) => {
        const normalized = Number(value);
        if (Number.isFinite(normalized) && normalized > 0) {
          accumulator[key] = normalized;
        }
        return accumulator;
      },
      {},
    );
  }

  private async getBuyerSavedMeasurementValues(userId: string) {
    const profile = await (this.prisma as any).userSizeFitProfile.findUnique({
      where: { userId },
      select: { measurements: true },
    });
    if (!profile?.measurements || typeof profile.measurements !== 'object' || Array.isArray(profile.measurements)) {
      return {};
    }

    return Object.entries(profile.measurements as Record<string, unknown>).reduce<Record<string, number>>(
      (accumulator, [key, value]) => {
        const normalized = Number(
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>).value
            : value,
        );
        if (Number.isFinite(normalized) && normalized > 0) {
          accumulator[key] = normalized;
        }
        return accumulator;
      },
      {},
    );
  }

  private async validateMeasurementRanges(
    requiredMeasurementKeys: string[],
    measurementValues: Record<string, number>,
  ) {
    const points = await this.prisma.measurementPoint.findMany({
      where: { key: { in: requiredMeasurementKeys } },
      select: { key: true, minValueCm: true, maxValueCm: true },
    });
    for (const point of points) {
      const value = Number(measurementValues[point.key]);
      if (!Number.isFinite(value)) {
        throw new BadRequestException(`Missing measurement value for ${point.key}`);
      }
      if (point.minValueCm != null && value < Number(point.minValueCm)) {
        throw new BadRequestException(`Measurement value for ${point.key} is below the allowed minimum`);
      }
      if (point.maxValueCm != null && value > Number(point.maxValueCm)) {
        throw new BadRequestException(`Measurement value for ${point.key} exceeds the allowed maximum`);
      }
    }
  }

  private async resolveSourceSnapshot(sourceType: CustomOrderSourceType, sourceId: string) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: sourceId },
        include: { brand: { select: { name: true } } },
      });
      if (!product) {
        throw new NotFoundException('Product source not found');
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
      throw new NotFoundException('Design source not found');
    }

    return {
      title: design.title ?? 'Untitled design',
      slug: null,
      primaryMediaUrl: design.coverMedia?.file.s3Url ?? design.medias[0]?.file.s3Url ?? null,
      brandName: design.owner.brand?.name ?? null,
    };
  }

  private resolveStageThreshold(stage: CustomOrderProgressStage, from: Date) {
    const hours = 24;
    return new Date(from.getTime() + hours * 60 * 60 * 1000);
  }

  private isExtensionRequestAllowed(status: CustomOrderStatus, targetType: string) {
    const productionEligible = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
    ]);
    const deliveryEligible = new Set<CustomOrderStatus>([
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
    ]);

    if (targetType === 'PRODUCTION') {
      return productionEligible.has(status);
    }
    if (targetType === 'DELIVERY') {
      return deliveryEligible.has(status);
    }
    return productionEligible.has(status);
  }

  private isLifecycleTransitionAllowed(currentStatus: CustomOrderStatus, nextStatus: CustomOrderStatus) {
    const transitions: Partial<Record<CustomOrderStatus, CustomOrderStatus[]>> = {
      [CustomOrderStatus.ACCEPTED]: [CustomOrderStatus.READY_FOR_DISPATCH],
      [CustomOrderStatus.IN_PRODUCTION]: [CustomOrderStatus.READY_FOR_DISPATCH],
      [CustomOrderStatus.READY_FOR_DISPATCH]: [CustomOrderStatus.IN_TRANSIT, CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
      [CustomOrderStatus.IN_TRANSIT]: [CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION],
      [CustomOrderStatus.COMPLETED]: [CustomOrderStatus.CLOSED],
    };

    return transitions[currentStatus]?.includes(nextStatus) ?? false;
  }

  private async applyExtensionDays(
    tx: Prisma.TransactionClient,
    customOrderId: string,
    requestedExtraDays: number,
    targetType: string,
  ) {
    const order = await tx.customOrder.findUnique({ where: { id: customOrderId } });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const dayMs = requestedExtraDays * 24 * 60 * 60 * 1000;
    await tx.customOrder.update({
      where: { id: customOrderId },
      data: {
        promisedProductionAt:
          targetType === 'PRODUCTION' || targetType === 'BOTH'
            ? order.promisedProductionAt
              ? new Date(order.promisedProductionAt.getTime() + dayMs)
              : null
            : order.promisedProductionAt,
        promisedDispatchAt:
          targetType === 'PRODUCTION' || targetType === 'BOTH'
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

  private mapListItem(order: Prisma.CustomOrderGetPayload<{}>) {
    const summary = order.buyerPriceSummaryJson as Record<string, unknown>;
    const measurementSnapshot =
      order.measurementSnapshotJson &&
      typeof order.measurementSnapshotJson === 'object' &&
      !Array.isArray(order.measurementSnapshotJson)
        ? (order.measurementSnapshotJson as Record<string, unknown>)
        : {};
    const contactInfo =
      order.contactInfoJson &&
      typeof order.contactInfoJson === 'object' &&
      !Array.isArray(order.contactInfoJson)
        ? (order.contactInfoJson as Record<string, unknown>)
        : {};
    const shippingAddress =
      order.shippingAddressJson &&
      typeof order.shippingAddressJson === 'object' &&
      !Array.isArray(order.shippingAddressJson)
        ? (order.shippingAddressJson as Record<string, unknown>)
        : {};

    return {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      sourceType: order.sourceType,
      sourceId: order.sourceId,
      sourceTitle: order.sourceTitleSnapshot || 'Untitled custom order',
      sourcePrimaryMediaUrl: order.sourcePrimaryMediaUrlSnapshot,
      brand: {
        name: order.sourceBrandNameSnapshot || 'Brand',
      },
      buyer: {
        name: typeof contactInfo.customerName === 'string' ? contactInfo.customerName : null,
        email: typeof contactInfo.email === 'string' ? contactInfo.email : null,
        phone: typeof contactInfo.phone === 'string' ? contactInfo.phone : null,
      },
      delivery: {
        city: typeof shippingAddress.city === 'string' ? shippingAddress.city : null,
        state: typeof shippingAddress.state === 'string' ? shippingAddress.state : null,
        country: typeof shippingAddress.country === 'string' ? shippingAddress.country : null,
      },
      buyerPriceSummary: {
        grandTotal: summary?.grandTotal,
        currency: order.currency,
      },
      measurementCount: Object.keys(measurementSnapshot).length,
      currentProgressStage: order.currentProgressStage,
      promisedDeliveryAt: order.promisedDeliveryAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private mapDetail(order: any) {
    const breakdown = (order.internalPriceBreakdownJson ?? {}) as Record<string, unknown>;
    const chartLock = (breakdown.chartLock ?? null) as Record<string, unknown> | null;
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
      quoteStatus: (chartLock?.quoteStatus as string | undefined) ?? 'AUTO_PRICED',
      chartLock,
      exceptionDecision: (breakdown.exceptionDecision ?? null) as Record<string, unknown> | null,
      measurementSnapshot: order.measurementSnapshotJson,
      measurementConfirmedAt: order.measurementConfirmedAt,
      shippingAddress: order.shippingAddressJson,
      contactInfo: order.contactInfoJson,
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

  private get detailIncludes() {
    return {
      progressEvents: { orderBy: { changedAt: 'asc' as const } },
      extensionRequests: { orderBy: { createdAt: 'desc' as const } },
      timelineEvents: { orderBy: { createdAt: 'asc' as const } },
      issues: { orderBy: { createdAt: 'desc' as const } },
      disputes: { orderBy: { openedAt: 'desc' as const } },
    };
  }
}
