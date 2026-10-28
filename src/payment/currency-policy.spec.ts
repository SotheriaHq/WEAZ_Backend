import {
  assertCatalogueCurrency,
  assertChargeCurrency,
  isChargeableCurrency,
} from './currency-policy';

describe('currency policy', () => {
  it('charges and prices in NGN only, whatever the casing', () => {
    expect(isChargeableCurrency('ngn')).toBe(true);
    expect(isChargeableCurrency(' NGN ')).toBe(true);
    expect(isChargeableCurrency('USD')).toBe(false);
    expect(isChargeableCurrency('')).toBe(false);
  });

  it('defaults a missing catalogue currency to NGN and refuses the rest in plain words', () => {
    expect(assertCatalogueCurrency(undefined)).toBe('NGN');
    expect(assertCatalogueCurrency('ngn')).toBe('NGN');
    expect(() => assertCatalogueCurrency('USD')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'CURRENCY_NOT_SUPPORTED_FOR_PRICES',
        }),
      }),
    );
  });

  it('refuses to charge a basket in a currency the gateway cannot collect', () => {
    expect(assertChargeCurrency('NGN')).toBe('NGN');
    expect(() => assertChargeCurrency('GBP')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'CHECKOUT_CURRENCY_NOT_CHARGEABLE',
        }),
      }),
    );
    expect(() => assertChargeCurrency(undefined)).toThrow();
  });
});
