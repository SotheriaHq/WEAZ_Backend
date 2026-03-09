import { PaymentMethod } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  street: string;
  apartment?: string;
  city: string;
  state: string;
  postalCode?: string;
  country: string;
  phone: string;
}

export class InitializePaymentDto {
  @IsArray()
  @IsString({ each: true })
  orderIds: string[];

  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsString()
  email: string;

  @IsOptional()
  @IsString()
  callbackUrl?: string;
}

export interface PaymentInitResult {
  reference: string;
  gateway: string;
  /** URL to redirect user (for Paystack/Flutterwave) */
  authorizationUrl?: string;
  /** Bank account details (for bank transfer) */
  bankAccount?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    expiresAt: string;
  };
  /** True if no redirect needed (e.g. pay on delivery) */
  directApproval?: boolean;
}

export class VerifyPaymentDto {
  @IsString()
  reference: string;

  @IsString()
  gateway: string;

  @IsOptional()
  @IsString()
  otp?: string;
}

export interface PaymentVerifyResult {
  success: boolean;
  reference: string;
  amount: number;
  currency: string;
  paidAt?: string;
  channel?: string;
  gatewayResponse?: string;
}

export interface CheckoutRequestDto {
  customerName: string;
  shippingAddress: ShippingAddress;
  contactInfo: { phone: string; email?: string };
  paymentMethod: PaymentMethod;
  promoCode?: string;
}

export const SHIPPING_RATES: Record<string, number> = {
  LAGOS: 2500,
  ABUJA: 3500,
  'PORT HARCOURT': 3500,
  DEFAULT: 4000,
};

export function calculateShipping(state: string): number {
  const key = state.toUpperCase().trim();
  return SHIPPING_RATES[key] ?? SHIPPING_RATES.DEFAULT;
}
