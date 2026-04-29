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
  | 'DISABLED';

export interface BagStatusDto {
  productId: string;
  canBag: boolean;
  bagMode: BagMode;
  standard: {
    available: boolean;
    alreadyBagged: boolean;
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
    missingMeasurementKeys: string[];
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
