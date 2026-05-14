import type {
  CustomOrderCheckoutStatus,
  CustomOrderSourceType,
  CustomOrderStatus,
  PaymentStatus,
  SizingMode,
} from '@prisma/client';

export type BagSourceType = 'PRODUCT' | 'DESIGN' | 'COLLECTION';

export type BagMode = 'STANDARD' | 'CUSTOM' | 'STANDARD_OR_CUSTOM' | 'UNAVAILABLE';

export type BagFittingState = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'NOT_REQUIRED';

export type BagFreshnessState = 'FRESH' | 'STALE' | 'MISSING' | 'PARTIAL' | 'NOT_REQUIRED';

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

export type CompletedDuplicatePolicy = 'ALLOW_REPEAT' | 'BLOCK_REPEAT' | 'UNKNOWN';

export type CustomDuplicateClass =
  | 'IN_BAG'
  | 'SUBMITTED_UNPAID'
  | 'PAID_ACTIVE'
  | 'COMPLETED_ALLOWED'
  | 'COMPLETED_BLOCKED'
  | 'UNKNOWN';

export interface FittingFreshnessResult {
  fittingState: BagFittingState;
  freshnessState: BagFreshnessState;
  missingMeasurementKeys: string[];
  measurementUpdatedAt: string | null;
  staleAfterDays: number;
  staleAt: string | null;
  requiresStaleConfirmation: boolean;
}

export interface BagDuplicateState {
  inBag: boolean;
  submittedUnpaid: boolean;
  paidActive: boolean;
  completedPolicy: CompletedDuplicatePolicy;
  reason: string | null;
  classifications: CustomDuplicateClass[];
}

export interface BagReadinessContract {
  productId: string;
  sourceType?: BagSourceType;
  sourceId?: string;
  canBag: boolean;
  bagMode: BagMode;
  reason: string | null;
  modes: {
    standard: boolean;
    customOrder: boolean;
  };
  standard: {
    available: boolean;
    enabled: boolean;
    alreadyBagged: boolean;
    inBag: boolean;
    cartItemId: string | null;
    selectedSize: string | null;
    selectedColor: string | null;
    quantity: number;
    requiresSize: boolean;
    requiresColor: boolean;
    sizes: string[];
    colors: string[];
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
    freshnessState: BagFreshnessState;
    missingMeasurementKeys: string[];
    measurementUpdatedAt: string | null;
    staleAfterDays: number;
    staleAt: string | null;
    requiresStaleConfirmation: boolean;
  };
  customOrder: {
    enabled: boolean;
    inBag: boolean;
    sessionId: string | null;
    checkoutIntentId: string | null;
    configurationId: string | null;
    requiredMeasurementKeys: string[];
    requiredFreeformPointIds: string[];
    fittingsComplete: boolean;
    freshnessState: BagFreshnessState;
    missingMeasurementKeys: string[];
    measurementUpdatedAt: string | null;
    staleAfterDays: number;
    staleAt: string | null;
    requiresStaleConfirmation: boolean;
  };
  duplicateState: BagDuplicateState;
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
  baggable: boolean;
}

export interface BagCountContract {
  standardQuantity: number;
  customLineCount: number;
  combinedCount: number;
}

export interface SizeFitProfileForFreshness {
  measurements?: unknown;
  lastUpdatedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  requireUpdateEveryDays?: number | null;
}

export interface StandardBagValidationInput {
  product: {
    id: string;
    name?: string | null;
    sizes?: string[] | null;
    colors?: string[] | null;
    variants?: Array<{ size?: string | null; color?: string | null; stock?: number | null }> | null;
    trackInventory?: boolean | null;
    allowBackorders?: boolean | null;
    totalStock?: number | null;
    sizeStock?: unknown;
    sizingMode?: SizingMode | string | null;
    customMeasurementKeys?: string[] | null;
  };
  selectedSize?: string | null;
  selectedColor?: string | null;
  resultingQuantity: number;
  sizingMode?: SizingMode | string | null;
  requiredMeasurementKeys?: string[] | null;
  sizeFitData?: Record<string, unknown> | null;
}

export interface CustomDuplicateClassificationInput {
  buyerId: string;
  sourceType: CustomOrderSourceType;
  sourceId: string;
  currentCheckoutSessionId?: string | null;
  currentCheckoutIntentId?: string | null;
}

export interface CustomOrderDuplicateRecord {
  id: string;
  status: CustomOrderStatus;
  paymentStatus: PaymentStatus;
}

export interface CheckoutSessionDuplicateRecord {
  id: string;
  checkoutIntentId: string;
  status: CustomOrderCheckoutStatus;
  customOrderId: string | null;
  lastAttemptStatus?: string | null;
}
