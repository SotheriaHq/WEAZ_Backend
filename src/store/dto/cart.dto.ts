import { IsString, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class AddToCartDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity?: number = 1;

  @IsOptional()
  @IsString()
  selectedSize?: string;

  @IsOptional()
  @IsString()
  selectedColor?: string;
}

export class UpdateCartItemDto {
  @IsNumber()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity: number;
}
