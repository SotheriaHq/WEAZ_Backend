export declare class CollectionCartPreviewResponseDto {
    collectionId: string;
    collectionTitle: string;
    available: CartPreviewItem[];
    unavailable: UnavailableCartPreviewItem[];
    summary: CartPreviewSummary;
}
export declare class CartPreviewItem {
    productId: string;
    name: string;
    thumbnail?: string;
    price: number;
    salePrice?: number;
    effectivePrice: number;
    currency: string;
    variants: CartPreviewVariant[];
    sizes?: string[];
    colors?: string[];
    defaultSize?: string;
    defaultColor?: string;
}
export declare class CartPreviewVariant {
    size?: string;
    color?: string;
    stock: number;
    inStock: boolean;
    price?: number;
}
export declare class UnavailableCartPreviewItem extends CartPreviewItem {
    reason: 'out_of_stock' | 'archived' | 'deleted' | 'inactive' | 'scheduled';
    availableAt?: string;
}
export declare class CartPreviewSummary {
    availableCount: number;
    unavailableCount: number;
    totalCount: number;
    availableSubtotal: number;
    currency: string;
}
export declare class BulkUploadInitiateDto {
    collectionId: string;
    mode?: 'csv' | 'images' | 'mixed';
}
export declare class BulkUploadRowDto {
    product_name: string;
    description?: string;
    price: number;
    sale_price?: number;
    sku?: string;
    sizes?: string;
    colors?: string;
    stock?: string;
    tags?: string;
    images?: string;
}
export declare class BulkUploadStatusDto {
    jobId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'partial';
    progress: number;
    totalRows: number;
    processedRows: number;
    successCount: number;
    failedCount: number;
    errors: BulkUploadError[];
    collectionId?: string;
    createdAt: string;
    completedAt?: string;
}
export declare class BulkUploadError {
    rowIndex: number;
    rowId?: string;
    productName?: string;
    field?: string;
    message: string;
    canRetry: boolean;
}
export declare class BulkUploadRetryDto {
    rowIndices: number[];
}
export declare class PriceChangePreviewDto {
    newPrice: number;
    newSalePrice?: number;
}
export declare class PriceChangePreviewResponse {
    productId: string;
    productName: string;
    currentPrice: number;
    newPrice: number;
    priceChange: number;
    percentageChange: number;
    affectedCollections: CollectionPriceImpact[];
}
export declare class CollectionPriceImpact {
    collectionId: string;
    collectionTitle: string;
    currentMinPrice: number;
    currentMaxPrice: number;
    newMinPrice: number;
    newMaxPrice: number;
    rangeChanged: boolean;
}
export declare class DraftSessionDto {
    sessionId: string;
    draftId: string;
    deviceInfo: string;
    startedAt: string;
    lastActiveAt: string;
}
export declare class DraftConflictDto {
    hasConflict: boolean;
    currentSession?: DraftSessionDto;
    conflictingSession?: DraftSessionDto;
    recommendedAction: 'continue' | 'view_only' | 'take_over';
}
export declare class DraftSaveDto {
    title?: string;
    description?: string;
    expectedVersion?: number;
    deviceInfo?: string;
}
export declare class DraftSaveConflictResponse {
    success: boolean;
    conflictDetected: boolean;
    serverVersion?: number;
    lastSavedAt?: string;
    lastSavedBy?: string;
    options: ('reload' | 'save_as_new' | 'force_save')[];
}
export declare class CustomFitInquiryDto {
    collectionId: string;
    productId?: string;
    message: string;
    measurements?: string;
    preferredSize?: string;
}
export declare class CustomFitInquiryResponse {
    success: boolean;
    inquiryId: string;
    message: string;
    estimatedResponseTime?: string;
}
