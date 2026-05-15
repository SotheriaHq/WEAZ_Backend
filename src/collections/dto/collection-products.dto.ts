import { IsArray, IsNumber, IsOptional, IsString, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';

// STORE_COLLECTION_GROUPING:
// These DTOs manage explicit product membership inside a StoreCollection
// grouping/container. They do not make collection own product inventory.
export class AddProductsDto {
  @IsArray()
  @IsString({ each: true })
  productIds: string[];
}

export class RemoveProductsDto {
  @IsArray()
  @IsString({ each: true })
  productIds: string[];
}

export class ReorderCollectionProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}

export class ReorderItemDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(0)
  orderIndex: number;
}

// STORE_COLLECTION_PRODUCT_TEMPLATE_COMPAT:
// Applies product defaults to products grouped by a StoreCollection. This is a
// deferred legacy workflow and should not be treated as collection-owned SKU,
// stock, or variant behavior in new code.
export class ApplyTemplateDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsNumber()
  basePrice?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sizeOptions?: string[];
}
