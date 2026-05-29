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
  BagFreshnessState,
  CollectionBagProductStatus,
  CollectionBagStatusContract,
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

  async getProductBagStatus(
    productId: string,
    userId?: string,
  ): Promise<BagReadinessContract> {
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
  ): Promise<BagReadinessContract | CollectionBagStatusContract> {
    const startedAt = Date.now();
    const sourceType = this.normalizeSourceType(sourceTypeRaw);
    try {
      if (sourceType === 'PRODUCT') {
        return this.getProductBagStatus(sourceId, userId);
      }

      if (sourceType === 'DESIGN') {
        return this.getDesignBagStatus(sourceId, userId);
      }

      return this.getCollectionBagStatus(sourceId, userId);
    } finally {
      this.debugTiming('source_status', startedAt, {
        sourceType,
        sourceId,
        authenticated: Boolean(userId),
      });
    }
  }

  async getCollectionBagStatus(
    collectionId: string,
    userId?: string,
  ): Promise<CollectionBagStatusContract> {
    const startedAt = Date.now();
    try {
      const collection = await this.prisma.storeCollection.findFirst({
        where: { id: collectionId, deletedAt: null },
        include: {
          owner: {
            select: {
              id: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                  ownerId: true,
                  currency: true,
                  isStoreOpen: true,
                },
              },
            },
          },
          products: {
            include: {
              product: {
                include: {
                  brand: {
                    select: {
                      id: true,
                      name: true,
                      ownerId: true,
                      currency: true,
                      isStoreOpen: true,
                    },
                  },
                  collection: {
                    select: {
                      id: true,
                      status: true,
                      isAvailableInStore: true,
                      deletedAt: true,
                    },
                  },
                  collections: {
                    select: {
                      collectionId: true,
                      collection: {
                        select: {
                          id: true,
                          status: true,
                          isAvailableInStore: true,
                          deletedAt: true,
                        },
                      },
                    },
                  },
                  variants: true,
                },
              },
            },
            orderBy: { orderIndex: 'asc' },
          },
        },
      });

      if (!collection) {
        throw new NotFoundException('Collection not found');
      }

      const isOwner = Boolean(userId && collection.ownerId === userId);
      const publicCollection =
        collection.isAvailableInStore !== false &&
        collection.status === CollectionStatus.PUBLISHED &&
        collection.visibility === CollectionVisibility.PUBLIC &&
        Boolean(collection.owner?.brand?.isStoreOpen) &&
        !collection.deletedAt;

      if (!isOwner && !publicCollection) {
        throw new NotFoundException('Collection not found');
      }

      const sizeFitProfile = userId
        ? await this.prisma.userSizeFitProfile.findUnique({
            where: { userId },
            select: {
              measurements: true,
              lastUpdatedAt: true,
              updatedAt: true,
              requireUpdateEveryDays: true,
            },
          })
        : null;

      const visibleLinks = (collection.products || []).filter((link: any) => {
        const product = link?.product;
        if (!product) return false;
        if (
          product.deletedAt ||
          product.archivedAt ||
          product.isActive === false
        )
          return false;
        if (!isOwner && product.publishAt && product.publishAt > new Date())
          return false;
        return true;
      });

      const products: CollectionBagProductStatus[] = [];
      for (const link of visibleLinks) {
        const product = link.product;
        const sourceStatus = await this.resolveProductReadiness(
          product,
          product.id,
          userId,
        );
        products.push(
          this.presentCollectionProductStatus(
            product,
            sourceStatus,
            sizeFitProfile,
          ),
        );
      }

      const currency =
        products.find((product) => product.currency)?.currency ??
        collection.owner?.brand?.currency ??
        'NGN';
      const prices = products
        .map((product) => product.price)
        .filter((price) => Number.isFinite(price));
      const directEligible = products.filter((product) => product.canBag);
      const alreadyInBagCount = products.filter(
        (product) => product.inBag,
      ).length;
      const blockedProducts = products.filter(
        (product) => !product.canBag && !product.inBag,
      );
      const requiresSelectionCount = products.filter(
        (product) => product.defaultAction === 'OPEN_SELECTOR',
      ).length;
      const requiresFittingsCount = products.filter(
        (product) => product.defaultAction === 'OPEN_FITTINGS',
      ).length;
      const staleFittingsCount = products.filter(
        (product) => product.defaultAction === 'CONFIRM_STALE_FITTINGS',
      ).length;
      const outOfStockCount = products.filter(
        (product) => product.stockState === 'OUT_OF_STOCK',
      ).length;
      const canBagSelected =
        Boolean(userId) && directEligible.length > 0 && !isOwner;
      const canBagAll =
        Boolean(userId) &&
        products.length > 0 &&
        !isOwner &&
        blockedProducts.length === 0 &&
        directEligible.length > 0;
      const disabledReason = isOwner
        ? 'Brands cannot bag their own collection.'
        : !userId
          ? 'Sign in to bag this collection.'
          : products.length === 0
            ? 'This collection has no available products to bag.'
            : directEligible.length === 0
              ? 'Resolve product blockers before bagging this collection.'
              : null;

      return {
        sourceType: 'COLLECTION',
        sourceId: collection.id,
        collection: {
          id: collection.id,
          title: collection.title,
          description: collection.description,
          brandId: collection.owner?.brand?.id ?? null,
          brandName: collection.owner?.brand?.name ?? null,
          coverImage: this.resolveCollectionCover(products),
          coverImageId: this.resolveCollectionCoverId(products),
          productCount: products.length,
          priceRange: {
            min: prices.length
              ? Math.min(...prices)
              : (collection.minPrice ?? null),
            max: prices.length
              ? Math.max(...prices)
              : (collection.maxPrice ?? null),
            currency,
          },
        },
        summary: {
          canBagAll,
          canBagSelected,
          eligibleCount: directEligible.length,
          blockedCount: blockedProducts.length,
          alreadyInBagCount,
          requiresSelectionCount,
          requiresFittingsCount,
          staleFittingsCount,
          outOfStockCount,
          totalPrice: directEligible.reduce(
            (sum, product) => sum + product.price,
            0,
          ),
          currency,
        },
        products,
        ui: {
          defaultAction: !userId
            ? 'AUTH_REQUIRED'
            : canBagAll
              ? 'BAG_ALL'
              : canBagSelected
                ? 'BAG_SELECTED'
                : blockedProducts.length > 0
                  ? 'RESOLVE_BLOCKERS'
                  : 'DISABLED',
          disabledReason,
        },
        featureFlags: {
          collectionReviewsEnabled:
            String(
              process.env.REVIEWS_PUBLIC_COLLECTION_ENABLED || '',
            ).toLowerCase() === 'true',
        },
      };
    } finally {
      this.debugTiming('collection_status', startedAt, {
        collectionId,
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
      variants.some(
        (variant: { stock?: number | null }) => Number(variant.stock || 0) > 0,
      );
    const variantSource = variants.filter(
      (variant: { stock?: number | null }) => Number(variant.stock || 0) > 0,
    );
    const optionSource = variantSource.length > 0 ? variantSource : variants;
    const requiresSize =
      optionSource.some((variant: { size?: string | null }) =>
        Boolean(variant.size),
      ) || product.sizes.length > 0;
    const requiresColor =
      optionSource.some((variant: { color?: string | null }) =>
        Boolean(variant.color),
      ) || product.colors.length > 0;
    const sizes = Array.from(
      new Set([
        ...optionSource
          .map((variant: { size?: string | null }) =>
            String(variant.size || '').trim(),
          )
          .filter(Boolean),
        ...product.sizes,
      ]),
    );
    const colors = Array.from(
      new Set([
        ...optionSource
          .map((variant: { color?: string | null }) =>
            String(variant.color || '').trim(),
          )
          .filter(Boolean),
        ...product.colors,
      ]),
    );

    const customConfigurationPromise =
      this.prisma.customOrderConfiguration.findFirst({
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

    const [
      cartItem,
      customConfiguration,
      sizeFitProfile,
      previousStandardOrder,
      previousCustomOrder,
    ] = userId
      ? await Promise.all([
          this.prisma.cartItem.findFirst({
            where: { userId, productId },
            select: {
              id: true,
              selectedSize: true,
              selectedColor: true,
              quantity: true,
            },
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

    const { customBagLine, duplicateState } =
      await this.resolveDuplicateContext({
        userId,
        sourceType: CustomOrderSourceType.PRODUCT,
        sourceId: productId,
        activeConfigurationId: customConfiguration?.id ?? null,
      });
    const fittingFreshness = this.resolveFittingFreshness(
      customConfiguration,
      sizeFitProfile,
    );
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
        !standardEnabled &&
        !customEnabled &&
        product.customOrderEnabled === true &&
        !customConfiguration
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

    const [customConfiguration, brand, sizeFitProfile, previousCustomOrder] =
      await Promise.all([
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
    const { customBagLine, duplicateState } =
      await this.resolveDuplicateContext({
        userId,
        sourceType: CustomOrderSourceType.DESIGN,
        sourceId,
        activeConfigurationId: customConfiguration?.id ?? null,
      });
    const fittingFreshness = this.resolveFittingFreshness(
      customConfiguration,
      sizeFitProfile,
    );
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
      | {
          requiredMeasurementKeys: string[];
          requiredFreeformPointIds: string[];
        }
      | null
      | undefined,
    sizeFitProfile: any,
  ): FittingFreshnessResult {
    return this.freshnessPolicy.evaluate({
      requiredMeasurementKeys:
        customConfiguration?.requiredMeasurementKeys ?? [],
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
          duplicateState: this.validationService.classifyDuplicateState({
            completedPolicy: 'ALLOW_REPEAT',
          }),
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
          duplicateState: this.validationService.classifyDuplicateState({
            completedPolicy: 'ALLOW_REPEAT',
          }),
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
        checkoutSessions.find((session) => session.customOrderId === null) ??
        null;

      return {
        customBagLine: customBagLine
          ? {
              id: customBagLine.id,
              checkoutIntentId: customBagLine.checkoutIntentId,
            }
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

  private presentCollectionProductStatus(
    product: any,
    sourceStatus: BagReadinessContract,
    sizeFitProfile: any,
  ): CollectionBagProductStatus {
    const price = this.effectiveProductPrice(product);
    const media = this.resolveProductMedia(product);
    const standardFittings = this.resolveStandardFittings(
      product,
      sizeFitProfile,
    );
    let defaultAction = sourceStatus.ui.defaultAction;
    let canBag =
      sourceStatus.modes.standard &&
      sourceStatus.ui.defaultAction === 'ADD_STANDARD' &&
      !sourceStatus.standard.inBag &&
      !sourceStatus.userState.isOwner;
    let reason = sourceStatus.ui.disabledReason ?? sourceStatus.reason;
    let requiredMeasurementKeys = sourceStatus.custom.requiredMeasurementKeys;
    let missingMeasurementKeys = sourceStatus.custom.missingMeasurementKeys;
    let freshnessState = sourceStatus.custom.freshnessState;

    if (sourceStatus.standard.inBag) {
      defaultAction = 'ALREADY_IN_BAG';
      canBag = false;
      reason = 'ALREADY_IN_BAG';
    }

    if (
      sourceStatus.modes.standard &&
      standardFittings.requiredMeasurementKeys.length > 0 &&
      !sourceStatus.standard.inBag
    ) {
      requiredMeasurementKeys = standardFittings.requiredMeasurementKeys;
      missingMeasurementKeys = standardFittings.missingMeasurementKeys;
      freshnessState = standardFittings.freshnessState;
      if (
        standardFittings.fittingState === 'MISSING' ||
        standardFittings.fittingState === 'PARTIAL'
      ) {
        defaultAction = 'OPEN_FITTINGS';
        canBag = false;
        reason = 'MISSING_FITTINGS';
      } else if (standardFittings.freshnessState === 'STALE') {
        defaultAction = 'CONFIRM_STALE_FITTINGS';
        canBag = false;
        reason = 'STALE_FITTINGS';
      }
    }

    if (defaultAction === 'OPEN_SELECTOR') {
      canBag = false;
      reason = reason ?? 'SELECTION_REQUIRED';
    }

    if (
      defaultAction === 'OPEN_CUSTOM_FLOW' ||
      defaultAction === 'OPEN_FITTINGS' ||
      defaultAction === 'CONFIRM_STALE_FITTINGS'
    ) {
      canBag = false;
      reason = reason ?? defaultAction;
    }

    return {
      productId: product.id,
      name: product.name,
      coverImage: media[0]?.url ?? product.thumbnail ?? null,
      coverImageId: media[0]?.fileId ?? null,
      media,
      price,
      currency: product.currency ?? product.brand?.currency ?? 'NGN',
      canBag,
      inBag: sourceStatus.standard.inBag,
      reason,
      stockState: sourceStatus.stockState,
      defaultAction,
      requiresSize: sourceStatus.standard.requiresSize,
      requiresColor: sourceStatus.standard.requiresColor,
      availableSizes: sourceStatus.standard.sizes,
      availableColors: sourceStatus.standard.colors,
      requiredMeasurementKeys,
      missingMeasurementKeys,
      freshnessState,
      sourceStatus,
    };
  }

  private resolveStandardFittings(
    product: any,
    sizeFitProfile: any,
  ): {
    requiredMeasurementKeys: string[];
    missingMeasurementKeys: string[];
    fittingState: string;
    freshnessState: BagFreshnessState;
  } {
    const sizingMode = String(product?.sizingMode ?? 'NONE');
    const requiredMeasurementKeys =
      sizingMode === 'RTW_PLUS_FITTINGS'
        ? this.normalizeKeys(product?.customMeasurementKeys)
        : [];
    const freshness = this.freshnessPolicy.evaluate({
      requiredMeasurementKeys,
      profile: sizeFitProfile,
    });

    return {
      requiredMeasurementKeys,
      missingMeasurementKeys: freshness.missingMeasurementKeys,
      fittingState: freshness.fittingState,
      freshnessState: freshness.freshnessState,
    };
  }

  private effectiveProductPrice(product: any): number {
    const now = new Date();
    const salePrice =
      product.salePrice &&
      (!product.saleStartAt || product.saleStartAt <= now) &&
      (!product.saleEndAt || product.saleEndAt >= now)
        ? Number(product.salePrice)
        : null;
    return Number(salePrice ?? product.price ?? 0);
  }

  private resolveProductMedia(
    product: any,
  ): Array<{ url: string | null; fileId: string | null }> {
    const media: Array<{ url: string | null; fileId: string | null }> = [];
    if (typeof product.thumbnail === 'string' && product.thumbnail.trim()) {
      media.push({ url: product.thumbnail.trim(), fileId: null });
    }
    if (Array.isArray(product.images)) {
      for (const image of product.images) {
        if (typeof image === 'string' && image.trim()) {
          const url = image.trim();
          if (!media.some((entry) => entry.url === url)) {
            media.push({ url, fileId: null });
          }
        }
      }
    }
    return media;
  }

  private resolveCollectionCover(
    products: CollectionBagProductStatus[],
  ): string | null {
    return products.find((product) => product.coverImage)?.coverImage ?? null;
  }

  private resolveCollectionCoverId(
    products: CollectionBagProductStatus[],
  ): string | null {
    return (
      products.find((product) => product.coverImageId)?.coverImageId ?? null
    );
  }

  private normalizeKeys(raw?: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(
        raw
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
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
      fittingFreshness: this.freshnessPolicy.evaluate({
        requiredMeasurementKeys: [],
      }),
      duplicateState: this.validationService.classifyDuplicateState({
        completedPolicy: 'UNKNOWN',
      }),
      disabledReason: input.disabledReason,
    });
  }

  private normalizeSourceType(raw: string): BagSourceType {
    const normalized = String(raw ?? '')
      .trim()
      .toUpperCase();
    if (
      normalized === 'PRODUCT' ||
      normalized === 'DESIGN' ||
      normalized === 'COLLECTION'
    ) {
      return normalized;
    }
    return 'COLLECTION';
  }

  private hasPublicStoreAccess(
    product: { collections?: Array<any> } | null | undefined,
  ): boolean {
    const links = Array.isArray(product?.collections)
      ? product.collections
      : [];
    if (links.length === 0) return true;

    return links.some((link: any) => {
      const collection = link?.collection;
      if (!collection) return false;
      if (collection.deletedAt) return false;
      return collection.isAvailableInStore && collection.status === 'PUBLISHED';
    });
  }

  private debugTiming(
    label: string,
    startedAt: number,
    context: Record<string, unknown>,
  ): void {
    if (!this.shouldLogTiming()) return;
    this.logger.debug({
      event: `bagging.${label}.duration`,
      durationMs: Date.now() - startedAt,
      ...context,
    });
  }

  private shouldLogTiming(): boolean {
    const explicitFlag = String(
      process.env.BAGGING_OBSERVABILITY || '',
    ).toLowerCase();
    return (
      explicitFlag === 'true' ||
      explicitFlag === '1' ||
      process.env.NODE_ENV !== 'production'
    );
  }
}
