import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class BulkProductIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  productIds: string[];
}

export class BulkDeleteProductsDto extends BulkProductIdsDto {

  @IsOptional()
  @IsBoolean()
  cancelPendingOrders?: boolean;
}

export class BulkArchiveProductsDto extends BulkProductIdsDto {}

export class BulkUnpublishProductsDto extends BulkProductIdsDto {}
