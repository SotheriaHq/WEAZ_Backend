import { PaymentMethod } from '@prisma/client';
import { IsArray, IsEnum, IsObject, IsOptional, IsString } from 'class-validator';

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

  @IsOptional()
  @IsObject()
  paymentData?: Record<string, any>;
}

export type PaymentChannel =
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'BANK_ACCOUNT'
  | 'USSD'
  | 'MOBILE_MONEY';

export interface PaymentNextAction {
  type:
    | 'REDIRECT'
    | 'BANK_TRANSFER_INSTRUCTIONS'
    | 'USSD_INSTRUCTIONS'
    | 'MOBILE_MONEY_APPROVAL'
    | 'BANK_ACCOUNT_AUTH'
    | 'PENDING_CONFIRMATION';
  title: string;
  description: string;
  instructions: string[];
  ctaLabel?: string;
  expiresAt?: string;
  ussdCode?: string;
  metadata?: Record<string, string>;
}

export type PaymentAttemptStatus =
  | 'PENDING'
  | 'REQUIRES_ACTION'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface PaymentInitResult {
  paymentAttemptId: string;
  reference: string;
  gateway: string;
  status: PaymentAttemptStatus;
  channel?: PaymentChannel;
  /** URL to redirect user (for Paystack/Flutterwave) */
  authorizationUrl?: string;
  callbackUrl?: string;
  /** Bank account details (for bank transfer) */
  bankAccount?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    expiresAt: string;
    amount?: number;
    narration?: string;
  };
  /** True if no redirect needed (e.g. pay on delivery) */
  directApproval?: boolean;
  nextAction?: PaymentNextAction;
}

export class VerifyPaymentDto {
  @IsString()
  reference: string;

  @IsString()
  gateway: string;

  @IsOptional()
  @IsString()
  otp?: string;

  @IsOptional()
  @IsString()
  statusHint?: string;
}

export interface PaymentVerifyResult {
  success: boolean;
  status: PaymentAttemptStatus;
  paymentAttemptId?: string;
  reference: string;
  amount: number;
  currency: string;
  paidAt?: string;
  channel?: string;
  gatewayResponse?: string;
  failureMessage?: string;
  orderIds?: string[];
}

export interface PaymentAttemptOrderSummaryItem {
  name: string;
  quantity: number;
  price: number;
}

export interface PaymentAttemptSummary {
  paymentAttemptId: string;
  reference: string;
  gateway: string;
  providerMode: 'mock' | 'live';
  paymentMethod: PaymentMethod;
  status: PaymentAttemptStatus;
  channel?: PaymentChannel;
  authorizationUrl?: string;
  callbackUrl?: string;
  bankAccount?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
    expiresAt: string;
    amount?: number;
    narration?: string;
  };
  paymentData?: Record<string, any>;
  nextAction?: PaymentNextAction;
  canRetry: boolean;
  canSimulate: boolean;
  orderIds: string[];
  summary: {
    items: PaymentAttemptOrderSummaryItem[];
    subtotal: number;
    shippingCost: number;
    discount: number;
    grandTotal: number;
    shippingName: string;
    shippingCity: string;
    shippingState: string;
  };
}

export class SimulatePaymentAttemptDto {
  @IsString()
  outcome: PaymentAttemptStatus;
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
