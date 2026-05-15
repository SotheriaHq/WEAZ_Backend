import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { CompleteDesignUploadDto, DesignMetadataDto } from './design-metadata.dto';

export class FinalizeDesignUploadDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteDesignUploadDto)
  completions?: CompleteDesignUploadDto[];

  @IsOptional()
  @IsBoolean()
  shouldPublish?: boolean;

  @IsOptional()
  @IsString()
  action?: 'publish' | 'draft';

  @IsOptional()
  @ValidateNested()
  @Type(() => DesignMetadataDto)
  designMetadata?: DesignMetadataDto;

  /*
   * Legacy compatibility only. Existing mobile clients still send this
   * property to /designs/:id/finalize. New design-facing clients should send
   * designMetadata.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => DesignMetadataDto)
  collectionMetadata?: DesignMetadataDto;

  @IsOptional()
  @IsString()
  coverMediaId?: string;

  @IsOptional()
  @IsString()
  draftSessionToken?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  draftVersion?: number;

  @IsOptional()
  @IsNumber()
  coverIndex?: number;
}
