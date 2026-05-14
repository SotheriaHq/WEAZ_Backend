export type BagMode = 'STANDARD' | 'CUSTOM' | 'STANDARD_OR_CUSTOM' | 'UNAVAILABLE';

export type BagFittingState = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'NOT_REQUIRED';

export type BagStockState = 'IN_STOCK' | 'OUT_OF_STOCK' | 'CUSTOM_ONLY' | 'UNAVAILABLE';

export type BagHeartbeatState =
  | 'not_bagged'
  | 'previously_bagged'
  | 'currently_bagged'
  | 'bagging'
  | 'disabled';

export type BagDefaultAction =
  | 'ADD_STANDARD'
  | 'OPEN_SELECTOR'
  | 'OPEN_CUSTOM_FLOW'
  | 'OPEN_FITTINGS'
  | 'CONFIRM_STALE_FITTINGS'
  | 'DISABLED';

export type BagFreshnessState = 'FRESH' | 'STALE' | 'MISSING' | 'PARTIAL' | 'NOT_REQUIRED';

export type BagSourceType = 'PRODUCT' | 'DESIGN' | 'COLLECTION';

export type BagCompletedDuplicatePolicy = 'ALLOW_REPEAT' | 'BLOCK_REPEAT' | 'UNKNOWN';

export interface BagStatusDto {
  productId: string;
  sourceType?: BagSourceType;
  sourceId?: string;
  canBag: boolean;
  bagMode: BagMode;
  reason?: string | null;
  modes?: {
    standard: boolean;
    customOrder: boolean;
  };
  standard: {
    available: boolean;
    enabled?: boolean;
    alreadyBagged: boolean;
    inBag?: boolean;
    cartItemId: string | null;
    requiresSize: boolean;
    requiresColor: boolean;
    selectedSize: string | null;
    selectedColor: string | null;
    sizes: string[];
    colors: string[];
    quantity: number;
    stock: number;
  };
  custom: {
    available: boolean;
    alreadyBagged: boolean;
    checkoutSessionId: string | null;
    checkoutIntentId: string | null;
    configurationId: string | null;
    requiredMeasurementKeys: string[];
    requiredFreeformPointIds: string[];
    fittingState: BagFittingState;
    freshnessState?: BagFreshnessState;
    missingMeasurementKeys: string[];
    measurementUpdatedAt?: string | null;
    staleAfterDays?: number;
    staleAt?: string | null;
    requiresStaleConfirmation?: boolean;
  };
  customOrder?: {
    enabled: boolean;
    inBag: boolean;
    sessionId: string | null;
    checkoutIntentId: string | null;
    configurationId: string | null;
    requiredMeasurementKeys: string[];
    requiredFreeformPointIds: string[];
    fittingsComplete: boolean;
    freshnessState?: BagFreshnessState;
    missingMeasurementKeys: string[];
    measurementUpdatedAt?: string | null;
    staleAfterDays?: number;
    staleAt?: string | null;
    requiresStaleConfirmation?: boolean;
  };
  duplicateState?: {
    inBag: boolean;
    submittedUnpaid: boolean;
    paidActive: boolean;
    completedPolicy: BagCompletedDuplicatePolicy;
    reason: string | null;
    classifications?: string[];
  };
  stockState: BagStockState;
  userState: {
    authenticated: boolean;
    isOwner: boolean;
    hasPreviouslyBaggedOrOrdered: boolean;
  };
  ui: {
    heartbeatState: BagHeartbeatState;
    defaultAction: BagDefaultAction;
    disabledReason: string | null;
  };
}
