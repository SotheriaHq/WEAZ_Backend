import { BadRequestException } from '@nestjs/common';
import { CustomOrderRuleValidatorService } from './custom-order-rule-validator.service';

describe('CustomOrderRuleValidatorService', () => {
  let service: CustomOrderRuleValidatorService;

  beforeEach(() => {
    service = new CustomOrderRuleValidatorService();
  });

  it('normalizes rules in priority order', () => {
    const rules = service.normalizeRules([
      {
        priority: 2,
        outputYards: '4.5',
        conditionsJson: {
          bust: { min: 100, max: 120 },
        },
      },
      {
        priority: 1,
        outputYards: '3.25',
        isFallback: true,
        conditionsJson: {},
      },
    ]);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      priority: 1,
      isFallback: true,
      outputYards: 3.25,
      conditions: [],
    });
    expect(rules[1]).toMatchObject({
      priority: 2,
      isFallback: false,
      outputYards: 4.5,
      conditions: [{ key: 'bust', min: 100, max: 120 }],
    });
  });

  it('rejects rule sets without exactly one fallback rule', () => {
    expect(() =>
      service.normalizeRules([
        {
          priority: 1,
          outputYards: '2.5',
          conditionsJson: {},
        },
      ]),
    ).toThrow(
      new BadRequestException('Exactly one fallback fabric rule is required'),
    );

    expect(() =>
      service.normalizeRules([
        {
          priority: 1,
          outputYards: '2.5',
          isFallback: true,
          conditionsJson: {},
        },
        {
          priority: 2,
          outputYards: '3.5',
          isFallback: true,
          conditionsJson: {},
        },
      ]),
    ).toThrow(
      new BadRequestException('Exactly one fallback fabric rule is required'),
    );
  });

  it('rejects duplicate priorities and duplicate signatures', () => {
    expect(() =>
      service.normalizeRules([
        {
          priority: 1,
          outputYards: '2.5',
          isFallback: true,
          conditionsJson: {},
        },
        {
          priority: 1,
          outputYards: '3.0',
          conditionsJson: {
            waist: { min: 70, max: 80 },
          },
        },
      ]),
    ).toThrow(
      new BadRequestException('Custom fabric rules must use unique priorities'),
    );

    expect(() =>
      service.normalizeRules([
        {
          priority: 1,
          outputYards: '2.5',
          isFallback: true,
          conditionsJson: {},
        },
        {
          priority: 2,
          outputYards: '3.0',
          conditionsJson: {
            waist: { min: 70, max: 80 },
          },
        },
        {
          priority: 3,
          outputYards: '3.5',
          conditionsJson: {
            waist: { min: 70, max: 80 },
          },
        },
      ]),
    ).toThrow(
      new BadRequestException('Duplicate custom fabric rules are not allowed'),
    );
  });
});
