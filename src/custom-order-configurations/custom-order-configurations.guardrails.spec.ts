import { BadRequestException } from '@nestjs/common';
import { CustomOrderConfigurationsService } from './custom-order-configurations.service';

/**
 * Phase 2B focused contract tests for delivery/rush guardrails.
 * validateConfigurationGuardrails is pure (reads only its args), so we exercise
 * it directly off the prototype without constructing the full service graph.
 */
describe('CustomOrderConfigurationsService delivery/rush guardrails (Phase 2B)', () => {
  const svc = Object.create(
    CustomOrderConfigurationsService.prototype,
  ) as CustomOrderConfigurationsService;
  const validate = (dto: any, rules: any[] = []) =>
    (svc as any).validateConfigurationGuardrails(dto, rules);

  const base = {
    rushEnabled: false,
    productionLeadDays: 5,
    deliveryMinDays: 2,
    deliveryMaxDays: 5,
    baseProductionCharge: '100',
    fabricCostPerYard: '10',
  };

  it('accepts delivery range of exactly 1 day', () => {
    expect(() =>
      validate({ ...base, deliveryMinDays: 1, deliveryMaxDays: 1 }),
    ).not.toThrow();
  });

  it('accepts delivery range 1-2', () => {
    expect(() =>
      validate({ ...base, deliveryMinDays: 1, deliveryMaxDays: 2 }),
    ).not.toThrow();
  });

  it('accepts delivery max of exactly 7 days', () => {
    expect(() =>
      validate({ ...base, deliveryMinDays: 3, deliveryMaxDays: 7 }),
    ).not.toThrow();
  });

  it('rejects delivery max of 0 with a field-mapped error', () => {
    expect.assertions(2);
    try {
      validate({ ...base, deliveryMinDays: 0, deliveryMaxDays: 0 });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'DELIVERY_RANGE_INVALID',
      });
    }
  });

  it('rejects delivery max above 7 (legacy 2-14 behaviour)', () => {
    expect(() =>
      validate({ ...base, deliveryMinDays: 2, deliveryMaxDays: 14 }),
    ).toThrow(BadRequestException);
  });

  it('rejects delivery min greater than delivery max', () => {
    expect(() =>
      validate({ ...base, deliveryMinDays: 6, deliveryMaxDays: 4 }),
    ).toThrow(BadRequestException);
  });

  it('keeps the 70% rush-fee cap as a field-mapped error', () => {
    expect.assertions(2);
    try {
      validate(
        {
          ...base,
          rushEnabled: true,
          rushFee: '1000', // far above 70% of 100 base
          rushProductionLeadDays: 2,
          productionLeadDays: 5,
        },
        [],
      );
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        field: 'rushFee',
        code: 'RUSH_FEE_CAP_EXCEEDED',
      });
    }
  });

  it('accepts a rush fee within the 70% cap with max 3-day (72h) turnaround', () => {
    expect(() =>
      validate(
        {
          ...base,
          rushEnabled: true,
          rushFee: '50', // within 70% of 100
          rushProductionLeadDays: 3,
          productionLeadDays: 5,
        },
        [],
      ),
    ).not.toThrow();
  });

  it('rejects rush turnaround above 3 days (72h)', () => {
    expect(() =>
      validate(
        {
          ...base,
          rushEnabled: true,
          rushFee: '50',
          rushProductionLeadDays: 4,
          productionLeadDays: 6,
        },
        [],
      ),
    ).toThrow(BadRequestException);
  });
});
