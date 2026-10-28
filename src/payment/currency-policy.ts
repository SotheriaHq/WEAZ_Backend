import { BadRequestException } from '@nestjs/common';

/**
 * The three currencies money passes through, kept apart on purpose.
 *
 * - Settlement (accounting) currency: NGN. Brand earnings, commissions, escrow,
 *   debt and payouts are NGN, converted once at the rate recorded when the
 *   customer paid (`ExchangeRateSnapshot`), never repriced later.
 * - Charge currency: what the gateway is asked to collect. Only currencies the
 *   merchant account and `PaymentService.initPaystack` both support. Today that
 *   is NGN alone; Paystack also lists GHS, KES, USD and ZAR, but each needs the
 *   merchant account enabled for it and the charge path widened together.
 * - Display currency: what a shopper reads. Any currency the FX table covers,
 *   always shown as an estimate next to the charge, never charged by itself.
 *
 * Catalogue prices are set in a charge currency, so a basket can always be paid.
 */
export const SETTLEMENT_CURRENCY = 'NGN';
export const CHARGE_CURRENCIES: readonly string[] = ['NGN'];

export const normalizeCurrencyCode = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toUpperCase();

export const isChargeableCurrency = (value: unknown): boolean =>
  CHARGE_CURRENCIES.includes(normalizeCurrencyCode(value));

/** A price a shopper cannot pay is refused where it is set, in plain words. */
export function assertCatalogueCurrency(value: unknown): string {
  const code = normalizeCurrencyCode(value || SETTLEMENT_CURRENCY);
  if (!isChargeableCurrency(code)) {
    throw new BadRequestException({
      code: 'CURRENCY_NOT_SUPPORTED_FOR_PRICES',
      message:
        'Set prices in Naira (NGN). Shoppers see an estimate in their own currency automatically.',
    });
  }
  return code;
}

/** Checkout never reserves stock for a basket the gateway cannot charge. */
export function assertChargeCurrency(value: unknown): string {
  const code = normalizeCurrencyCode(value);
  if (!isChargeableCurrency(code)) {
    throw new BadRequestException({
      code: 'CHECKOUT_CURRENCY_NOT_CHARGEABLE',
      message:
        'Some items in your bag cannot be paid for right now. Remove them and try again.',
    });
  }
  return code;
}
