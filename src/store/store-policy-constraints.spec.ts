import {
  assertStorePolicyConstraints,
  sanitizeCustomOrderLeadTime,
  sanitizeResponseTimeSla,
  sanitizeReturnWindow,
  sanitizeShippingRegions,
} from './store-policy-constraints';

describe('store-policy-constraints', () => {
  it('strips international shipping regions', () => {
    expect(sanitizeShippingRegions(['nigeria', 'international'])).toEqual(['nigeria']);
  });

  it('rejects invalid return windows and response SLAs', () => {
    expect(() =>
      assertStorePolicyConstraints({ returnWindow: '30' }),
    ).toThrow(/7 or 14 days/i);
    expect(() =>
      assertStorePolicyConstraints({ responseTimeSla: '48h' }),
    ).toThrow(/24 hours/i);
  });

  it('rejects custom-order lead times above 7 days', () => {
    expect(() =>
      assertStorePolicyConstraints({
        shippingRules: {
          customOrderSettings: { leadTime: '14-21' },
        },
      }),
    ).toThrow(/7 days/i);
    expect(sanitizeCustomOrderLeadTime('30-plus')).toBe('4-7');
    expect(sanitizeReturnWindow('30')).toBe('14');
    expect(sanitizeResponseTimeSla('48h')).toBe('24h');
  });
});