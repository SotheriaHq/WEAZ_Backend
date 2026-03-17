import { BadRequestException, Injectable } from '@nestjs/common';
import { calculateShipping } from 'src/payment/payment.types';
import {
  CustomOrderRuleValidatorService,
  NormalizedCustomFabricRule,
} from './custom-order-rule-validator.service';

export interface CustomOrderPriceSummary {
  outfitTotal: string;
  delivery: string;
  rush: string;
  grandTotal: string;
  currency: string;
}

export interface CustomOrderInternalBreakdown {
  baseProductionCharge: string;
  fabricCostPerYard: string;
  computedYards: string;
  fabricComponentTotal: string;
  rushFee: string;
  deliveryFee: string;
  subtotalBeforeDelivery: string;
  grandTotal: string;
  matchedRulePriority: number | null;
  matchedRuleFallback: boolean;
}

export interface PriceConfigurationInput {
  baseProductionCharge: string | number;
  fabricCostPerYard: string | number;
  rushEnabled: boolean;
  rushFee?: string | number | null;
  baseYardsOverride?: number;
  additionalYards?: number;
  rules: NormalizedCustomFabricRule[];
  requiredMeasurementKeys: string[];
  measurementValues: Record<string, number>;
  rushSelected?: boolean;
  shippingAddress?: Record<string, unknown>;
  currency?: string;
}

@Injectable()
export class CustomOrderPricingService {
  constructor(
    private readonly ruleValidator: CustomOrderRuleValidatorService,
  ) {}

  validateConfigurationRules(
    rules: Array<{
      priority: number;
      outputYards: string | number;
      isFallback?: boolean;
      conditionsJson: Record<string, unknown>;
    }>,
  ) {
    return this.ruleValidator.normalizeRules(rules);
  }

  buildPricePreview(input: PriceConfigurationInput) {
    const rules = [...input.rules].sort((left, right) => left.priority - right.priority);
    this.ensureRequiredMeasurements(input.requiredMeasurementKeys, input.measurementValues);

    const matchedRule =
      rules.find((rule) => !rule.isFallback && this.ruleMatches(rule, input.measurementValues)) ??
      rules.find((rule) => rule.isFallback);

    if (!matchedRule) {
      throw new BadRequestException('No matching fabric rule found and no fallback rule is configured');
    }

    const baseProductionCharge = this.toMoney(input.baseProductionCharge);
    const fabricCostPerYard = this.toMoney(input.fabricCostPerYard);
    const additionalYards = this.roundMoney(Number(input.additionalYards ?? 0));
    if (!Number.isFinite(additionalYards) || additionalYards < 0) {
      throw new BadRequestException('Additional yards must be zero or greater');
    }

    const baseYardsOverride = Number(input.baseYardsOverride);
    const baseYards = Number.isFinite(baseYardsOverride) && baseYardsOverride > 0
      ? this.roundMoney(baseYardsOverride)
      : this.roundMoney(matchedRule.outputYards);

    const computedYards = this.roundMoney(baseYards + additionalYards);
    const fabricComponentTotal = this.roundMoney(computedYards * fabricCostPerYard);
    const rushFeeValue = input.rushSelected
      ? this.resolveRushFee(input.rushEnabled, input.rushFee)
      : 0;
    const subtotalBeforeDelivery = this.roundMoney(
      baseProductionCharge + fabricComponentTotal + rushFeeValue,
    );
    const deliveryFee = this.resolveDeliveryFee(input.shippingAddress);
    const grandTotal = this.roundMoney(subtotalBeforeDelivery + deliveryFee);

    const buyerPriceSummary: CustomOrderPriceSummary = {
      outfitTotal: this.formatMoney(subtotalBeforeDelivery),
      delivery: this.formatMoney(deliveryFee),
      rush: this.formatMoney(rushFeeValue),
      grandTotal: this.formatMoney(grandTotal),
      currency: input.currency ?? 'NGN',
    };

    const internalPriceBreakdown: CustomOrderInternalBreakdown = {
      baseProductionCharge: this.formatMoney(baseProductionCharge),
      fabricCostPerYard: this.formatMoney(fabricCostPerYard),
      computedYards: this.formatMoney(computedYards),
      fabricComponentTotal: this.formatMoney(fabricComponentTotal),
      rushFee: this.formatMoney(rushFeeValue),
      deliveryFee: this.formatMoney(deliveryFee),
      subtotalBeforeDelivery: this.formatMoney(subtotalBeforeDelivery),
      grandTotal: this.formatMoney(grandTotal),
      matchedRulePriority: matchedRule.priority,
      matchedRuleFallback: matchedRule.isFallback,
    };

    return {
      matchedRule,
      computedYards: this.formatMoney(computedYards),
      buyerPriceSummary,
      internalPriceBreakdown,
    };
  }

  private ensureRequiredMeasurements(
    requiredMeasurementKeys: string[],
    measurementValues: Record<string, number>,
  ) {
    if (!measurementValues || typeof measurementValues !== 'object') {
      throw new BadRequestException('Measurement values are required');
    }

    for (const key of requiredMeasurementKeys) {
      const value = measurementValues[key];
      if (!Number.isFinite(Number(value))) {
        throw new BadRequestException(`Missing measurement value for ${key}`);
      }
    }
  }

  private ruleMatches(
    rule: NormalizedCustomFabricRule,
    measurementValues: Record<string, number>,
  ) {
    return rule.conditions.every((condition) => {
      const rawValue = measurementValues[condition.key];
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        return false;
      }
      if (condition.min != null && value < condition.min) {
        return false;
      }
      if (condition.max != null && value > condition.max) {
        return false;
      }
      return true;
    });
  }

  private resolveRushFee(rushEnabled: boolean, rushFee?: string | number | null) {
    if (!rushEnabled) {
      throw new BadRequestException('Rush ordering is not enabled for this custom configuration');
    }

    const numericRushFee = this.toMoney(rushFee ?? 0);
    if (numericRushFee <= 0) {
      throw new BadRequestException('Rush ordering requires a positive rush fee');
    }

    return numericRushFee;
  }

  private resolveDeliveryFee(shippingAddress?: Record<string, unknown>) {
    const state = String(shippingAddress?.state ?? '').trim();
    if (!state) {
      return 0;
    }
    return this.roundMoney(calculateShipping(state));
  }

  private toMoney(value: string | number | null | undefined) {
    const numericValue = Number(value ?? 0);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      throw new BadRequestException('Invalid monetary value supplied to custom-order pricing');
    }
    return this.roundMoney(numericValue);
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private formatMoney(value: number) {
    return this.roundMoney(value).toFixed(2);
  }
}
