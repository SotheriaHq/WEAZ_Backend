import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AddProductsDto {
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
  orderIndex: number;
}

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
