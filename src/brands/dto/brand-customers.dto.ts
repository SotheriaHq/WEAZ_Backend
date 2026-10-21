import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class BrandCustomersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 25;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class UpdateCustomerSettingsDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  minimumOrders: number;
}
