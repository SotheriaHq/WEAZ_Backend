import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SizingMode } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import { BagCountPresenter } from './bag-count.presenter';
import { BagEligibilityService } from './bag-eligibility.service';
import { BagValidationService } from './bag-validation.service';
import type {
  CollectionBagMutationResult,
  CollectionBagProductStatus,
  CollectionBagStatusContract,
} from './bagging.types';
import type {
  BagCollectionAllDto,
  BagCollectionSelectedDto,
  CollectionBagSelectionDto,
} from './dto/collection-bagging.dto';

type PreparedAdd = {
  productId: string;
  quantity: number;
  selectedSize: string | null;
  selectedColor: string | null;
  sizingMode: SizingMode;
  requiredMeasurementKeys: string[];
  sizeFitData: Record<string, unknown> | null;
  existingItem: { id: string; quantity: number } | null;
};

@Injectable()
export class CollectionBaggingService {
  private readonly logger = new Logger(CollectionBaggingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: BagEligibilityService,
    private readonly validationService: BagValidationService,
    private readonly countPresenter: BagCountPresenter,
  ) {}

  async bagAll(
    collectionId: string,
    userId: string,
    dto: BagCollectionAllDto = {},
  ): Promise<CollectionBagMutationResult> {
    const startedAt = Date.now();
    try {
      const status = await this.eligibilityService.getCollectionBagStatus(collectionId, userId);
      return this.mutateCollection(status, userId, status.products.map((product) => product.productId), dto);
    } finally {
      this.debugTiming('collection_bag_all', startedAt, { collectionId, userId });
    }
  }

  async bagSelected(
    collectionId: string,
    userId: string,
    dto: BagCollectionSelectedDto,
  ): Promise<CollectionBagMutationResult> {
    const startedAt = Date.now();
    try {
      const productIds = this.uniqueIds(dto?.productIds);
      if (productIds.length === 0) {
        throw new BadRequestException('Select at least one collection product to bag.');
      }

      const status = await this.eligibilityService.getCollectionBagStatus(collectionId, userId);
      return this.mutateCollection(status, userId, productIds, dto);
    } finally {
      this.debugTiming('collection_bag_selected', startedAt, { collectionId, userId });
    }
  }

  private async mutateCollection(
    status: CollectionBagStatusContract,
    userId: string,
    requestedProductIds: string[],
    dto: BagCollectionAllDto,
  ): Promise<CollectionBagMutationResult> {
    const requestedSet = new Set(this.uniqueIds(requestedProductIds));
    const selectedStatuses = status.products.filter((product) => requestedSet.has(product.productId));
    if (selectedStatuses.length === 0) {
      throw new BadRequestException('No selected products belong to this collection.');
    }

    const skipped = selectedStatuses
      .filter((product) => product.inBag || product.defaultAction === 'ALREADY_IN_BAG')
      .map((product) => ({ productId: product.productId, reason: 'ALREADY_IN_BAG' }));

    const candidates = selectedStatuses.filter(
      (product) => !product.inBag && product.defaultAction !== 'ALREADY_IN_BAG',
    );
    const productRows = await this.fetchProducts(candidates.map((product) => product.productId));
    const productById = new Map(productRows.map((product) => [product.id, product] as const));
    const sizeFitProfile = await this.prisma.userSizeFitProfile.findUnique({
      where: { userId },
      select: {
        measurements: true,
        lastUpdatedAt: true,
        updatedAt: true,
        requireUpdateEveryDays: true,
      },
    });

    const prepared: PreparedAdd[] = [];
    const blocked: CollectionBagMutationResult['blocked'] = [];

    for (const item of candidates) {
      const product = productById.get(item.productId);
      if (!product) {
        blocked.push({ productId: item.productId, reason: 'PRODUCT_UNAVAILABLE' });
        continue;
      }

      const selection = this.selectionFor(dto, item.productId);
      const quantity = this.normalizeQuantity(selection?.quantity);
      const selectedSize = this.normalizeString(selection?.selectedSize);
      const selectedColor = this.normalizeString(selection?.selectedColor);
      const standardFittingRequired = this.isStandardFittingRequired(product);
      const staleAcknowledged = Boolean(dto.acknowledgements?.staleFittingsAccepted);

      if (!item.sourceStatus.modes.standard) {
        blocked.push(this.blockedItem(item, item.reason ?? item.defaultAction));
        continue;
      }

      if (item.defaultAction === 'OPEN_FITTINGS') {
        blocked.push(this.blockedItem(item, 'MISSING_FITTINGS'));
        continue;
      }

      if (item.defaultAction === 'CONFIRM_STALE_FITTINGS' && !staleAcknowledged) {
        blocked.push(this.blockedItem(item, 'STALE_FITTINGS_ACK_REQUIRED'));
        continue;
      }

      if (item.defaultAction === 'OPEN_SELECTOR') {
        const missingSize = item.requiresSize && !selectedSize;
        const missingColor = item.requiresColor && !selectedColor;
        if (missingSize || missingColor) {
          blocked.push({
            productId: item.productId,
            reason:
              missingSize && missingColor
                ? 'SIZE_COLOR_SELECTION_REQUIRED'
                : missingSize
                  ? 'SIZE_SELECTION_REQUIRED'
                  : 'COLOR_SELECTION_REQUIRED',
          });
          continue;
        }
      }

      if (
        !['ADD_STANDARD', 'OPEN_SELECTOR', 'CONFIRM_STALE_FITTINGS'].includes(item.defaultAction)
      ) {
        blocked.push(this.blockedItem(item, item.reason ?? item.defaultAction));
        continue;
      }

      const existingItem = await this.prisma.cartItem.findFirst({
        where: {
          userId,
          productId: item.productId,
          selectedSize,
          selectedColor,
        },
        select: { id: true, quantity: true },
      });
      const requiredMeasurementKeys = standardFittingRequired
        ? this.normalizeKeys(product.customMeasurementKeys)
        : [];
      const sizeFitData =
        standardFittingRequired && sizeFitProfile?.measurements
          ? { measurements: sizeFitProfile.measurements }
          : null;

      try {
        this.validationService.validateStandardBagInput({
          product,
          selectedSize,
          selectedColor,
          resultingQuantity: (existingItem?.quantity ?? 0) + quantity,
          sizingMode: product.sizingMode,
          requiredMeasurementKeys,
          sizeFitData,
        });
      } catch (error: any) {
        blocked.push({
          productId: item.productId,
          reason: error?.response?.message ?? error?.message ?? 'PRODUCT_VALIDATION_FAILED',
          missingMeasurementKeys: item.missingMeasurementKeys,
          requiredMeasurementKeys: item.requiredMeasurementKeys,
        });
        continue;
      }

      prepared.push({
        productId: item.productId,
        quantity,
        selectedSize,
        selectedColor,
        sizingMode: standardFittingRequired ? SizingMode.RTW_PLUS_FITTINGS : SizingMode.NONE,
        requiredMeasurementKeys,
        sizeFitData,
        existingItem,
      });
    }

    if (blocked.length > 0) {
      const count = await this.countPresenter.getCount(userId);
      return this.emptyResult(status.sourceId, skipped, blocked, count.combinedCount);
    }

    const added = await this.prisma.$transaction(async (tx) => {
      const rows: Array<{ productId: string; bagItemId: string; quantity: number }> = [];
      for (const item of prepared) {
        if (item.existingItem) {
          const updated = await tx.cartItem.update({
            where: { id: item.existingItem.id },
            data: {
              quantity: item.existingItem.quantity + item.quantity,
              sizingMode: item.sizingMode,
              requiredMeasurementKeys: item.requiredMeasurementKeys,
              sizeFitData: item.sizeFitData as any,
            },
            select: { id: true, quantity: true },
          });
          rows.push({ productId: item.productId, bagItemId: updated.id, quantity: updated.quantity });
          continue;
        }

        const created = await tx.cartItem.create({
          data: {
            id: uuidv4(),
            userId,
            productId: item.productId,
            quantity: item.quantity,
            selectedSize: item.selectedSize,
            selectedColor: item.selectedColor,
            sizingMode: item.sizingMode,
            requiredMeasurementKeys: item.requiredMeasurementKeys,
            sizeFitData: item.sizeFitData as any,
          },
          select: { id: true, quantity: true },
        });
        rows.push({ productId: item.productId, bagItemId: created.id, quantity: created.quantity });
      }
      return rows;
    });

    const count = await this.countPresenter.getCount(userId);
    return {
      collectionId: status.sourceId,
      added,
      skipped,
      blocked,
      summary: {
        addedCount: added.length,
        skippedCount: skipped.length,
        blockedCount: blocked.length,
        combinedBagCount: count.combinedCount,
      },
    };
  }

  private emptyResult(
    collectionId: string,
    skipped: CollectionBagMutationResult['skipped'],
    blocked: CollectionBagMutationResult['blocked'],
    combinedBagCount: number,
  ): CollectionBagMutationResult {
    return {
      collectionId,
      added: [],
      skipped,
      blocked,
      summary: {
        addedCount: 0,
        skippedCount: skipped.length,
        blockedCount: blocked.length,
        combinedBagCount,
      },
    };
  }

  private async fetchProducts(productIds: string[]) {
    if (productIds.length === 0) return [];
    return this.prisma.product.findMany({
      where: { id: { in: this.uniqueIds(productIds) }, deletedAt: null, isActive: true },
      include: { variants: true },
    });
  }

  private selectionFor(dto: BagCollectionAllDto, productId: string): CollectionBagSelectionDto | null {
    const selections = dto.selections ?? {};
    const selection = selections[productId];
    return selection && typeof selection === 'object' ? selection : null;
  }

  private blockedItem(product: CollectionBagProductStatus, reason: string) {
    return {
      productId: product.productId,
      reason,
      missingMeasurementKeys: product.missingMeasurementKeys,
      requiredMeasurementKeys: product.requiredMeasurementKeys,
    };
  }

  private uniqueIds(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return Array.from(
      new Set(
        values
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private normalizeString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private normalizeQuantity(value: unknown): number {
    const parsed = Number(value ?? 1);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(99, Math.max(1, Math.trunc(parsed)));
  }

  private isStandardFittingRequired(product: any): boolean {
    return (
      String(product?.sizingMode ?? 'NONE') === SizingMode.RTW_PLUS_FITTINGS &&
      this.normalizeKeys(product?.customMeasurementKeys).length > 0
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
