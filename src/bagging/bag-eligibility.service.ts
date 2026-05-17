import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CollectionStatus,
  CollectionVisibility,
  CustomOrderSourceType,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BagReadinessPresenter } from './bag-readiness.presenter';
import { BagValidationService } from './bag-validation.service';
import { FittingFreshnessPolicy } from './fitting-freshness.policy';
import type {
  BagDuplicateState,
  BagReadinessContract,
  BagSourceType,
  FittingFreshnessResult,
} from './bagging.types';

@Injectable()
export class BagEligibilityService {
  private readonly logger = new Logger(BagEligibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessPolicy: FittingFreshnessPolicy,
    private readonly validationService: BagValidationService,
    private readonly readinessPresenter: BagReadinessPresenter,
  ) {}

  async getProductBagStatus(productId: string, userId?: string): Promise<BagReadinessContract> {
    const startedAt = Date.now();
    try {
      const product = await this.prisma.product.findFirst({
        where: { id: productId, deletedAt: null },
        include: {
          brand: {
            select: {
              ownerId: true,
              isStoreOpen: true,
            },
          },
          collection: {
            select: {
              status: true,
              isAvailableInStore: true,
              deletedAt: true,
            },
          },
          collections: {
            select: {
              collection: {
                select: {
                  status: true,
                  isAvailableInStore: true,
                  deletedAt: true,
                },
              },
            },
          },
          variants: true,
        },
      });

      if (!product) {
        throw new NotFoundException('Product not found');
      }

      return this.resolveProductReadiness(product, productId, userId);
    } finally {
      this.debugTiming('product_status', startedAt, {
        productId,
        authenticated: Boolean(userId),
      });
    }
  }

  async getSourceBagStatus(
    sourceTypeRaw: string,
    sourceId: string,
    userId?: string,
  ): Promise<BagReadinessContract> {
    const startedAt = Date.now();
    const sourceType = this.normalizeSourceType(sourceTypeRaw);
    try {
      if (sourceType === 'PRODUCT') {
        return this.getProductBagStatus(sourceId, userId);
      }

      if (sourceType === 'DESIGN') {
        return this.getDesignBagStatus(sourceId, userId);
      }

      return this.unavailableSourceStatus({
        sourceType,
        sourceId,
        reason: 'COLLECTION_SOURCE_BAGGING_NOT_CONFIGURED',
        disabledReason:
          'Store collection source bagging is not configured yet. Use product-level bagging for collection products.',
        authenticated: Boolean(userId),
      });
    } finally {
      this.debugTiming('source_status', startedAt, {
        sourceType,
        sourceId,
        authenticated: Boolean(userId),
      });
    }
  }

  private async resolveProductReadiness(
    product: any,
    productId: string,
    userId?: string,
  ): Promise<BagReadinessContract> {
    const isOwner = Boolean(userId && product.brand?.ownerId === userId);
    const publicProduct =
      !product.deletedAt &&
      !product.archivedAt &&
      product.isActive !== false &&
      Boolean(product.brand?.isStoreOpen) &&
      this.hasPublicStoreAccess(product);
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const inStock =
      !product.trackInventory ||
      product.allowBackorders ||
      Number(product.totalStock || 0) > 0 ||
      variants.some((variant: { stock?: number | null }) => Number(variant.stock || 0) > 0);
    const variantSource = variants.filter((variant: { stock?: number | null }) => Number(variant.stock || 0) > 0);
    const optionSource = variantSource.length > 0 ? variantSource : variants;
    const requiresSize =
      optionSource.some((variant: { size?: string | null }) => Boolean(variant.size)) ||
      product.sizes.length > 0;
    const requiresColor =
      optionSource.some((variant: { color?: string | null }) => Boolean(variant.color)) ||
      product.colors.length > 0;
    const sizes = Array.from(
      new Set([
        ...optionSource.map((variant: { size?: string | null }) => String(variant.size || '').trim()).filter(Boolean),
        ...product.sizes,
      ]),
    );
    const colors = Array.from(
      new Set([
        ...optionSource.map((variant: { color?: string | null }) => String(variant.color || '').trim()).filter(Boolean),
        ...product.colors,
      ]),
    );

    const customConfigurationPromise = this.prisma.customOrderConfiguration.findFirst({
      where: {
        sourceType: CustomOrderSourceType.PRODUCT,
        sourceId: productId,
        isActive: true,
      },
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        requiredMeasurementKeys: true,
        requiredFreeformPointIds: true,
      },
    });

    const [cartItem, customConfiguration, sizeFitProfile, previousStandardOrder, previousCustomOrder] =
      userId
        ? await Promise.all([
            this.prisma.cartItem.findFirst({
              where: { userId, productId },
              select: { id: true, selectedSize: true, selectedColor: true, quantity: true },
              orderBy: { createdAt: 'desc' },
            }),
            customConfigurationPromise,
            this.prisma.userSizeFitProfile.findUnique({
              where: { userId },
              select: {
                measurements: true,
                lastUpdatedAt: true,
                updatedAt: true,
                requireUpdateEveryDays: true,
              },
            }),
            this.prisma.orderItem.findFirst({
              where: { buyerId: userId, productId },
              select: { id: true },
            }),
            this.prisma.customOrder.findFirst({
              where: {
                buyerId: userId,
                sourceType: CustomOrderSourceType.PRODUCT,
                sourceId: productId,
              },
              select: { id: true },
            }),
          ])
        : await Promise.all([
            Promise.resolve(null),
            customConfigurationPromise,
            Promise.resolve(null),
            Promise.resolve(null),
            Promise.resolve(null),
          ]);

    const { customBagLine, duplicateState } = await this.resolveDuplicateContext({
      userId,
      sourceType: CustomOrderSourceType.PRODUCT,
      sourceId: productId,
      activeConfigurationId: customConfiguration?.id ?? null,
    });
    const fittingFreshness = this.resolveFittingFreshness(customConfiguration, sizeFitProfile);
    const standardEnabled =
      product.standardCheckoutEnabled !== false &&
      publicProduct &&
      inStock &&
      !isOwner;
    const customEnabled =
      product.customOrderEnabled === true &&
      Boolean(customConfiguration) &&
      publicProduct &&
      !isOwner;

    return this.readinessPresenter.present({
      productId,
      sourceType: 'PRODUCT',
      sourceId: productId,
      standardEnabled,
      customEnabled,
      publicSource: publicProduct,
      isOwner,
      authenticated: Boolean(userId),
      inStock,
      stock: Number(product.totalStock || 0),
      requiresSize,
      requiresColor,
      sizes,
      colors,
      cartItem,
      customBagLine,
      customConfiguration,
      fittingFreshness,
      duplicateState,
      previousStandardOrder,
      previousCustomOrder,
      disabledReason:
        !standardEnabled && !customEnabled && product.customOrderEnabled === true && !customConfiguration
          ? 'This product needs an active custom-order configuration before it can be bagged.'
          : null,
    });
  }

  private async getDesignBagStatus(
    sourceId: string,
    userId?: string,
  ): Promise<BagReadinessContract> {
    const design = await this.prisma.collection.findFirst({
      where: {
        id: sourceId,
        deletedAt: null,
      },
      select: {
        id: true,
        ownerId: true,
        status: true,
        visibility: true,
        customOrderEnabled: true,
      },
    });

    if (!design) {
      return this.unavailableSourceStatus({
        sourceType: 'DESIGN',
        sourceId,
        reason: 'DESIGN_NOT_FOUND',
        disabledReason: 'This design is unavailable.',
        authenticated: Boolean(userId),
      });
    }

    const [customConfiguration, brand, sizeFitProfile, previousCustomOrder] = await Promise.all([
      this.prisma.customOrderConfiguration.findFirst({
        where: {
          sourceType: CustomOrderSourceType.DESIGN,
          sourceId,
          isActive: true,
        },
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          requiredMeasurementKeys: true,
          requiredFreeformPointIds: true,
        },
      }),
      this.prisma.brand.findUnique({
        where: { ownerId: design.ownerId },
        select: { isStoreOpen: true },
      }),
      userId
        ? this.prisma.userSizeFitProfile.findUnique({
            where: { userId },
            select: {
              measurements: true,
              lastUpdatedAt: true,
              updatedAt: true,
              requireUpdateEveryDays: true,
            },
          })
        : Promise.resolve(null),
      userId
        ? this.prisma.customOrder.findFirst({
            where: {
              buyerId: userId,
              sourceType: CustomOrderSourceType.DESIGN,
              sourceId,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const publicDesign =
      design.status === CollectionStatus.PUBLISHED &&
      design.visibility === CollectionVisibility.PUBLIC &&
      Boolean(brand?.isStoreOpen);
    const isOwner = Boolean(userId && userId === design.ownerId);
    const { customBagLine, duplicateState } = await this.resolveDuplicateContext({
      userId,
      sourceType: CustomOrderSourceType.DESIGN,
      sourceId,
      activeConfigurationId: customConfiguration?.id ?? null,
    });
    const fittingFreshness = this.resolveFittingFreshness(customConfiguration, sizeFitProfile);
    const customEnabled =
      design.customOrderEnabled === true &&
      Boolean(customConfiguration) &&
      publicDesign &&
      !isOwner;

    return this.readinessPresenter.present({
      productId: sourceId,
      sourceType: 'DESIGN',
      sourceId,
      standardEnabled: false,
      customEnabled,
      publicSource: publicDesign,
      isOwner,
      authenticated: Boolean(userId),
      inStock: false,
      stock: 0,
      requiresSize: false,
      requiresColor: false,
      sizes: [],
      colors: [],
      cartItem: null,
      customBagLine,
      customConfiguration,
      fittingFreshness,
      duplicateState,
      previousCustomOrder,
      disabledReason:
        design.customOrderEnabled === true && !customConfiguration
          ? 'This design needs an active custom-order configuration before it can be bagged.'
          : null,
    });
  }

  private resolveFittingFreshness(
    customConfiguration:
      | { requiredMeasurementKeys: string[]; requiredFreeformPointIds: string[] }
      | null
      | undefined,
    sizeFitProfile: any,
  ): FittingFreshnessResult {
    return this.freshnessPolicy.evaluate({
      requiredMeasurementKeys: customConfiguration?.requiredMeasurementKeys ?? [],
      profile: sizeFitProfile,
    });
  }

  private async resolveDuplicateContext(input: {
    userId?: string;
    sourceType: CustomOrderSourceType;
    sourceId: string;
    activeConfigurationId?: string | null;
  }): Promise<{
    customBagLine: { id: string; checkoutIntentId: string } | null;
    duplicateState: BagDuplicateState;
  }> {
    const startedAt = Date.now();
    if (!input.userId) {
      try {
        return {
          customBagLine: null,
          duplicateState: this.validationService.classifyDuplicateState({ completedPolicy: 'ALLOW_REPEAT' }),
        };
      } finally {
        this.debugTiming('duplicate_classification', startedAt, {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          authenticated: false,
        });
      }
    }

    try {
      const sourceConfigIds = (
        await this.prisma.customOrderConfiguration.findMany({
          where: {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
          select: { id: true },
        })
      ).map((entry) => entry.id);

      const activeConfigIds = input.activeConfigurationId
        ? Array.from(new Set([input.activeConfigurationId, ...sourceConfigIds]))
        : sourceConfigIds;

      if (activeConfigIds.length === 0) {
        return {
          customBagLine: null,
          duplicateState: this.validationService.classifyDuplicateState({ completedPolicy: 'ALLOW_REPEAT' }),
        };
      }

      const [checkoutSessions, customOrders] = await Promise.all([
        this.prisma.customOrderCheckoutSession.findMany({
          where: {
            buyerId: input.userId,
            checkoutIntent: {
              configurationId: { in: activeConfigIds },
            },
          },
          select: {
            id: true,
            checkoutIntentId: true,
            status: true,
            customOrderId: true,
            lastAttemptStatus: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.customOrder.findMany({
          where: {
            buyerId: input.userId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
          select: {
            id: true,
            status: true,
            paymentStatus: true,
          },
        }),
      ]);

      const customBagLine =
        checkoutSessions.find((session) => session.customOrderId === null) ?? null;

      return {
        customBagLine: customBagLine
          ? { id: customBagLine.id, checkoutIntentId: customBagLine.checkoutIntentId }
          : null,
        duplicateState: this.validationService.classifyDuplicateState({
          checkoutSessions,
          customOrders,
          completedPolicy: 'ALLOW_REPEAT',
        }),
      };
    } finally {
      this.debugTiming('duplicate_classification', startedAt, {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        authenticated: true,
      });
    }
  }

  private unavailableSourceStatus(input: {
    sourceType: BagSourceType;
    sourceId: string;
    reason: string;
    disabledReason: string;
    authenticated: boolean;
  }): BagReadinessContract {
    return this.readinessPresenter.present({
      productId: input.sourceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      standardEnabled: false,
      customEnabled: false,
      publicSource: false,
      isOwner: false,
      authenticated: input.authenticated,
      inStock: false,
      stock: 0,
      requiresSize: false,
      requiresColor: false,
      sizes: [],
      colors: [],
      cartItem: null,
      customBagLine: null,
      customConfiguration: null,
      fittingFreshness: this.freshnessPolicy.evaluate({ requiredMeasurementKeys: [] }),
      duplicateState: this.validationService.classifyDuplicateState({
        completedPolicy: 'UNKNOWN',
      }),
      disabledReason: input.disabledReason,
    });
  }

  private normalizeSourceType(raw: string): BagSourceType {
    const normalized = String(raw ?? '').trim().toUpperCase();
    if (normalized === 'PRODUCT' || normalized === 'DESIGN' || normalized === 'COLLECTION') {
      return normalized;
    }
    return 'COLLECTION';
  }

  private hasPublicStoreAccess(product: { collections?: Array<any> } | null | undefined): boolean {
    const links = Array.isArray(product?.collections) ? product.collections : [];
    if (links.length === 0) return true;

    return links.some((link: any) => {
      const collection = link?.collection;
      if (!collection) return false;
      if (collection.deletedAt) return false;
      return collection.isAvailableInStore && collection.status === 'PUBLISHED';
    });
  }

  private debugTiming(label: string, startedAt: number, context: Record<string, unknown>): void {
    if (!this.shouldLogTiming()) return;
    this.logger.debug({
      event: `bagging.${label}.duration`,
      durationMs: Date.now() - startedAt,
      ...context,
    });
  }

  private shouldLogTiming(): boolean {
    const explicitFlag = String(process.env.BAGGING_OBSERVABILITY || '').toLowerCase();
    return explicitFlag === 'true' || explicitFlag === '1' || process.env.NODE_ENV !== 'production';
  }
}
