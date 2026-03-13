import { BadRequestException } from '@nestjs/common';
import { CustomOrderPricingService } from './custom-order-pricing.service';
import { CustomOrderRuleValidatorService } from './custom-order-rule-validator.service';

describe('CustomOrderPricingService', () => {
  let service: CustomOrderPricingService;

  beforeEach(() => {
    service = new CustomOrderPricingService(new CustomOrderRuleValidatorService());
  });

  it('builds a price preview from the matching rule with rush and delivery', () => {
    const result = service.buildPricePreview({
      baseProductionCharge: '15000',
      fabricCostPerYard: '2000',
      rushEnabled: true,
      rushFee: '5000',
      rules: service.validateOfferRules([
        {
          priority: 1,
          outputYards: '4.5',
          conditionsJson: {
            bust: { min: 95, max: 110 },
          },
        },
        {
          priority: 2,
          outputYards: '3.0',
          isFallback: true,
          conditionsJson: {},
        },
      ]),
      requiredMeasurementKeys: ['bust'],
      measurementValues: { bust: 100 },
      rushSelected: true,
      shippingAddress: { state: 'Lagos' },
      currency: 'NGN',
    });

    expect(result.computedYards).toBe('4.50');
    expect(result.matchedRule.priority).toBe(1);
    expect(result.buyerPriceSummary).toEqual({
      outfitTotal: '29000.00',
      delivery: '2500.00',
      rush: '5000.00',
      grandTotal: '31500.00',
      currency: 'NGN',
    });
    expect(result.internalPriceBreakdown).toMatchObject({
      baseProductionCharge: '15000.00',
      fabricCostPerYard: '2000.00',
      fabricComponentTotal: '9000.00',
      matchedRulePriority: 1,
      matchedRuleFallback: false,
    });
  });

  it('falls back when no conditional rule matches', () => {
    const result = service.buildPricePreview({
      baseProductionCharge: '10000',
      fabricCostPerYard: '1500',
      rushEnabled: false,
      rules: service.validateOfferRules([
        {
          priority: 1,
          outputYards: '5',
          conditionsJson: {
            waist: { min: 60, max: 65 },
          },
        },
        {
          priority: 2,
          outputYards: '3.5',
          isFallback: true,
          conditionsJson: {},
        },
      ]),
      requiredMeasurementKeys: ['waist'],
      measurementValues: { waist: 80 },
      currency: 'NGN',
    });

    expect(result.computedYards).toBe('3.50');
    expect(result.matchedRule.isFallback).toBe(true);
    expect(result.buyerPriceSummary.grandTotal).toBe('15250.00');
  });

  it('rejects missing required measurements', () => {
    expect(() =>
      service.buildPricePreview({
        baseProductionCharge: '10000',
        fabricCostPerYard: '1500',
        rushEnabled: false,
        rules: service.validateOfferRules([
          {
            priority: 1,
            outputYards: '3',
            isFallback: true,
            conditionsJson: {},
          },
        ]),
        requiredMeasurementKeys: ['hip'],
        measurementValues: {},
        currency: 'NGN',
      }),
    ).toThrow(new BadRequestException('Missing measurement value for hip'));
  });

  it('rejects rush selection when rush is disabled', () => {
    expect(() =>
      service.buildPricePreview({
        baseProductionCharge: '10000',
        fabricCostPerYard: '1500',
        rushEnabled: false,
        rushFee: '2500',
        rules: service.validateOfferRules([
          {
            priority: 1,
            outputYards: '3',
            isFallback: true,
            conditionsJson: {},
          },
        ]),
        requiredMeasurementKeys: [],
        measurementValues: {},
        rushSelected: true,
        currency: 'NGN',
      }),
    ).toThrow(new BadRequestException('Rush ordering is not enabled for this custom offer'));
  });
});