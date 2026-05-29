import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { Gender, MeasurementPointCategory } from '@prisma/client';

export class CreateFreeformPointDto {
  @IsString()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9\- ]+$/, {
    message: 'label can contain only letters, numbers, spaces, and hyphens',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  description?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(MeasurementPointCategory)
  category: MeasurementPointCategory;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(300)
  minValueCm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(300)
  maxValueCm?: number;
}
