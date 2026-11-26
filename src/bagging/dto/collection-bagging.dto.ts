import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DiscoveryAttributionDto } from 'src/common/discovery-attribution';

export class CollectionBagSelectionDto {
  @IsOptional()
  @IsString()
  selectedSize?: string;

  @IsOptional()
  @IsString()
  selectedColor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity?: number;
}

export class CollectionBagAcknowledgementsDto {
  @IsOptional()
  @IsBoolean()
  staleFittingsAccepted?: boolean;
}

/** Optional sourceSection/sourcePosition: where in Market the collection was opened. */
export class BagCollectionAllDto extends DiscoveryAttributionDto {
  @IsOptional()
  @IsObject()
  selections?: Record<string, CollectionBagSelectionDto>;

  @IsOptional()
  @IsObject()
  acknowledgements?: CollectionBagAcknowledgementsDto;
}

export class BagCollectionSelectedDto extends BagCollectionAllDto {
  @IsArray()
  @IsString({ each: true })
  productIds: string[];
}
