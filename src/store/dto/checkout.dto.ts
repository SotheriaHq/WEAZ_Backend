import {
  IsArray,
  IsOptional,
  IsString,
  IsEnum,
  ValidateNested,
  IsNumber,
  IsObject,
  IsNotEmpty,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';
import {
  IsPhoneNumberField,
  ToE164Phone,
} from '../../common/decorators/is-phone-number.decorator';
import { PHONE_E164_MAX_LENGTH } from '../../common/utils/phone-number';

export class CheckoutItemDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @IsOptional()
  @IsString()
  selectedSize?: string;

  @IsOptional()
  @IsString()
  selectedColor?: string;
}

export class ShippingAddressDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsString()
  street: string;

  @IsOptional()
  @IsString()
  apartment?: string;

  @IsString()
  city: string;

  @IsString()
  state: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsString()
  country: string;

  @ToE164Phone()
  @IsString()
  @IsNotEmpty()
  @IsPhoneNumberField()
  @MaxLength(PHONE_E164_MAX_LENGTH)
  phone: string;
}

export class CheckoutDto {
  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress?: ShippingAddressDto | Record<string, any>;

  @IsOptional()
  contactInfo?: Record<string, any>;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  promoCode?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items?: CheckoutItemDto[];
}
