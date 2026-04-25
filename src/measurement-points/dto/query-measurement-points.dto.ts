import { Transform } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';
import { Gender, MeasurementPointCategory } from '@prisma/client';

export class QueryMeasurementPointsDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(MeasurementPointCategory)
  category?: MeasurementPointCategory;
}
