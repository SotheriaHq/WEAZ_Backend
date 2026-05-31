import { Injectable } from '@nestjs/common';
import type {
  BagDefaultAction,
  BagDuplicateState,
  BagHeartbeatState,
  BagMode,
  BagReadinessContract,
  BagSourceType,
  BagStockState,
  FittingFreshnessResult,
} from './bagging.types';

@Injectable()
export class BagReadinessPresenter {
  present(input: {
    productId: string;
    sourceType?: BagSourceType;
    sourceId?: string;
    standardEnabled: boolean;
    customEnabled: boolean;
    publicSource: boolean;
    isOwner: boolean;
    authenticated: boolean;
    inStock: boolean;
    stock: number;
    requiresSize: boolean;
    requiresColor: boolean;
    sizes: string[];
    colors: string[];
    cartItem?: {
      id: string;
      selectedSize: string | null;
      selectedColor: string | null;
      quantity: number;
    } | null;
    customBagLine?: {
      id: string;
      checkoutIntentId: string;
    } | null;
    customConfiguration?: {
      id: string | null;
      requiredMeasurementKeys: string[];
      requiredFreeformPointIds: string[];
    } | null;
    fittingFreshness: FittingFreshnessResult;
    duplicateState: BagDuplicateState;
    previousStandardOrder?: unknown | null;
    previousCustomOrder?: unknown | null;
    disabledReason?: string | null;
  }): BagReadinessContract {
    const canBag = input.standardEnabled || input.customEnabled;
    const bagMode: BagMode =
      input.standardEnabled && input.customEnabled
        ? 'STANDARD_OR_CUSTOM'
        : input.standardEnabled
          ? 'STANDARD'
          : input.customEnabled
            ? 'CUSTOM'
            : 'UNAVAILABLE';
    const stockState: BagStockState = !input.publicSource
      ? 'UNAVAILABLE'
      : input.inStock
        ? 'IN_STOCK'
        : input.customEnabled
          ? 'CUSTOM_ONLY'
          : 'OUT_OF_STOCK';

    const hasPreviouslyBaggedOrOrdered = Boolean(
      input.cartItem ||
        input.customBagLine ||
        input.previousStandardOrder ||
        input.previousCustomOrder,
    );
    const disabledReason =
      input.disabledReason ?? this.resolveDisabledReason(input);
    const heartbeatState: BagHeartbeatState = !canBag
      ? 'disabled'
      : input.cartItem || input.customBagLine
        ? 'currently_bagged'
        : hasPreviouslyBaggedOrOrdered
          ? 'previously_bagged'
          : 'not_bagged';
    const defaultAction = this.resolveDefaultAction({
      canBag,
      standardEnabled: input.standardEnabled,
      customEnabled: input.customEnabled,
      requiresSize: input.requiresSize,
      requiresColor: input.requiresColor,
      freshnessState: input.fittingFreshness.freshnessState,
      fittingState: input.fittingFreshness.fittingState,
    });

    const requiredMeasurementKeys =
      input.customConfiguration?.requiredMeasurementKeys ?? [];
    const requiredFreeformPointIds =
      input.customConfiguration?.requiredFreeformPointIds ?? [];

    return {
      productId: input.productId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      canBag,
      bagMode,
      reason: disabledReason ? disabledReason : !canBag ? 'NO_BAG_MODE' : null,
      modes: {
        standard: input.standardEnabled,
        customOrder: input.customEnabled,
      },
      standard: {
        available: input.standardEnabled,
        enabled: input.standardEnabled,
        alreadyBagged: Boolean(input.cartItem),
        inBag: Boolean(input.cartItem),
        cartItemId: input.cartItem?.id ?? null,
        selectedSize: input.cartItem?.selectedSize ?? null,
        selectedColor: input.cartItem?.selectedColor ?? null,
        quantity: input.cartItem?.quantity ?? 0,
        requiresSize: input.requiresSize,
        requiresColor: input.requiresColor,
        sizes: input.sizes,
        colors: input.colors,
        stock: input.stock,
      },
      custom: {
        available: input.customEnabled,
        alreadyBagged: Boolean(input.customBagLine),
        checkoutSessionId: input.customBagLine?.id ?? null,
        checkoutIntentId: input.customBagLine?.checkoutIntentId ?? null,
        configurationId: input.customConfiguration?.id ?? null,
        requiredMeasurementKeys,
        requiredFreeformPointIds,
        fittingState: input.fittingFreshness.fittingState,
        freshnessState: input.fittingFreshness.freshnessState,
        missingMeasurementKeys: input.fittingFreshness.missingMeasurementKeys,
        staleMeasurementKeys: input.fittingFreshness.staleMeasurementKeys,
        veryStaleMeasurementKeys:
          input.fittingFreshness.veryStaleMeasurementKeys,
        measurementUpdatedAt: input.fittingFreshness.measurementUpdatedAt,
        staleAfterDays: input.fittingFreshness.staleAfterDays,
        staleAt: input.fittingFreshness.staleAt,
        veryStaleAfterDays: input.fittingFreshness.veryStaleAfterDays,
        veryStaleAt: input.fittingFreshness.veryStaleAt,
        requiresStaleConfirmation:
          input.fittingFreshness.requiresStaleConfirmation,
      },
      customOrder: {
        enabled: input.customEnabled,
        inBag: Boolean(input.customBagLine),
        sessionId: input.customBagLine?.id ?? null,
        checkoutIntentId: input.customBagLine?.checkoutIntentId ?? null,
        configurationId: input.customConfiguration?.id ?? null,
        requiredMeasurementKeys,
        requiredFreeformPointIds,
        fittingsComplete:
          input.fittingFreshness.fittingState === 'COMPLETE' ||
          input.fittingFreshness.fittingState === 'NOT_REQUIRED',
        freshnessState: input.fittingFreshness.freshnessState,
        missingMeasurementKeys: input.fittingFreshness.missingMeasurementKeys,
        staleMeasurementKeys: input.fittingFreshness.staleMeasurementKeys,
        veryStaleMeasurementKeys:
          input.fittingFreshness.veryStaleMeasurementKeys,
        measurementUpdatedAt: input.fittingFreshness.measurementUpdatedAt,
        staleAfterDays: input.fittingFreshness.staleAfterDays,
        staleAt: input.fittingFreshness.staleAt,
        veryStaleAfterDays: input.fittingFreshness.veryStaleAfterDays,
        veryStaleAt: input.fittingFreshness.veryStaleAt,
        requiresStaleConfirmation:
          input.fittingFreshness.requiresStaleConfirmation,
      },
      duplicateState: input.duplicateState,
      stockState,
      userState: {
        authenticated: input.authenticated,
        isOwner: input.isOwner,
        hasPreviouslyBaggedOrOrdered,
      },
      ui: {
        heartbeatState,
        defaultAction,
        disabledReason,
      },
      baggable: canBag,
    };
  }

  private resolveDefaultAction(input: {
    canBag: boolean;
    standardEnabled: boolean;
    customEnabled: boolean;
    requiresSize: boolean;
    requiresColor: boolean;
    fittingState: string;
    freshnessState: string;
  }): BagDefaultAction {
    if (!input.canBag) return 'DISABLED';
    if (input.standardEnabled && input.customEnabled) return 'OPEN_SELECTOR';
    if (input.standardEnabled && (input.requiresSize || input.requiresColor))
      return 'OPEN_SELECTOR';
    if (input.fittingState === 'MISSING' || input.fittingState === 'PARTIAL')
      return 'OPEN_FITTINGS';
    if (
      input.freshnessState === 'STALE' ||
      input.freshnessState === 'VERY_STALE'
    )
      return 'CONFIRM_STALE_FITTINGS';
    if (input.standardEnabled) return 'ADD_STANDARD';
    if (input.customEnabled) return 'OPEN_CUSTOM_FLOW';
    return 'DISABLED';
  }

  private resolveDisabledReason(input: {
    isOwner: boolean;
    publicSource: boolean;
    standardEnabled: boolean;
    customEnabled: boolean;
    inStock: boolean;
    customConfiguration?: { id: string } | null;
  }): string | null {
    if (input.isOwner) return 'Brands cannot bag their own products.';
    if (!input.publicSource) return 'This source is unavailable.';
    if (!input.standardEnabled && !input.customEnabled && !input.inStock) {
      return 'This product is out of stock.';
    }
    if (
      !input.standardEnabled &&
      !input.customEnabled &&
      !input.customConfiguration
    ) {
      return 'This source needs an active custom-order configuration before it can be bagged.';
    }
    if (!input.standardEnabled && !input.customEnabled) {
      return 'This source is not available for bagging.';
    }
    return null;
  }
}
