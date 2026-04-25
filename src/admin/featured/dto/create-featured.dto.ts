import {
  IsString,
  IsUUID,
  IsIn,
  IsOptional,
  IsDateString,
  IsArray,
  IsBoolean,
} from 'class-validator';

export class CreateFeaturedDto {
  @IsString()
  @IsIn(['PRODUCT', 'DESIGN'])
  entityType: string;

  @IsUUID()
  entityId: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  displayImages?: string[];

  @IsOptional()
  @IsBoolean()
  useCoverOnly?: boolean;
}
