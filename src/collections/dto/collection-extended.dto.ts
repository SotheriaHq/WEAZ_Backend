import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================
// Cart Preview DTOs
// ============================================

export class CollectionCartPreviewResponseDto {
  collectionId: string;
  collectionTitle: string;
  available: CartPreviewItem[];
  unavailable: UnavailableCartPreviewItem[];
  summary: CartPreviewSummary;
}

export class CartPreviewItem {
  productId: string;
  name: string;
  thumbnail?: string;
  price: number;
  salePrice?: number;
  effectivePrice: number;
  currency: string;
  variants: CartPreviewVariant[];
  defaultSize?: string;
  defaultColor?: string;
}

export class CartPreviewVariant {
  size?: string;
  color?: string;
  stock: number;
  inStock: boolean;
  price?: number;
}

export class UnavailableCartPreviewItem extends CartPreviewItem {
  reason: 'out_of_stock' | 'archived' | 'deleted' | 'inactive' | 'scheduled';
  availableAt?: string; // For scheduled products
}

export class CartPreviewSummary {
  availableCount: number;
  unavailableCount: number;
  totalCount: number;
  availableSubtotal: number;
  currency: string;
}

// ============================================
// Bulk Upload DTOs
// ============================================

export class BulkUploadInitiateDto {
  @IsString()
  collectionId: string;

  @IsOptional()
  @IsString()
  mode?: 'csv' | 'images' | 'mixed';
}

export class BulkUploadRowDto {
  @IsString()
  product_name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  sale_price?: number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  sizes?: string; // Comma-separated

  @IsOptional()
  @IsString()
  colors?: string; // Comma-separated

  @IsOptional()
  @IsString()
  stock?: string; // Comma-separated per size

  @IsOptional()
  @IsString()
  tags?: string; // Comma-separated

  @IsOptional()
  @IsString()
  images?: string; // Comma-separated filenames
}

export class BulkUploadStatusDto {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partial';
  progress: number; // 0-100
  totalRows: number;
  processedRows: number;
  successCount: number;
  failedCount: number;
  errors: BulkUploadError[];
  collectionId?: string;
  createdAt: string;
  completedAt?: string;
}

export class BulkUploadError {
  rowIndex: number;
  rowId?: string;
  productName?: string;
  field?: string;
  message: string;
  canRetry: boolean;
}

export class BulkUploadRetryDto {
  @IsArray()
  @IsNumber({}, { each: true })
  rowIndices: number[];
}

// ============================================
// Price Preview DTOs
// ============================================

export class PriceChangePreviewDto {
  @IsNumber()
  @Min(0)
  newPrice: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  newSalePrice?: number;
}

export class PriceChangePreviewResponse {
  productId: string;
  productName: string;
  currentPrice: number;
  newPrice: number;
  priceChange: number;
  percentageChange: number;
  affectedCollections: CollectionPriceImpact[];
}

export class CollectionPriceImpact {
  collectionId: string;
  collectionTitle: string;
  currentMinPrice: number;
  currentMaxPrice: number;
  newMinPrice: number;
  newMaxPrice: number;
  rangeChanged: boolean;
}

// ============================================
// Draft Conflict DTOs
// ============================================

export class DraftSessionDto {
  sessionId: string;
  draftId: string;
  deviceInfo: string;
  startedAt: string;
  lastActiveAt: string;
}

export class DraftConflictDto {
  hasConflict: boolean;
  currentSession?: DraftSessionDto;
  conflictingSession?: DraftSessionDto;
  recommendedAction: 'continue' | 'view_only' | 'take_over';
}

export class DraftSaveDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

export class DraftSaveConflictResponse {
  success: boolean;
  conflictDetected: boolean;
  serverVersion?: number;
  lastSavedAt?: string;
  lastSavedBy?: string;
  options: ('reload' | 'save_as_new' | 'force_save')[];
}

// ============================================
// Custom Fit Inquiry DTOs (Scaffold)
// ============================================

export class CustomFitInquiryDto {
  @IsString()
  collectionId: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  measurements?: string;

  @IsOptional()
  @IsString()
  preferredSize?: string;
}

export class CustomFitInquiryResponse {
  success: boolean;
  inquiryId: string;
  message: string;
  estimatedResponseTime?: string;
}
