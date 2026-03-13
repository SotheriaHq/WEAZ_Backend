import { BadRequestException, Injectable } from '@nestjs/common';

export interface NormalizedRuleCondition {
  key: string;
  min?: number;
  max?: number;
}

export interface NormalizedCustomFabricRule {
  priority: number;
  isFallback: boolean;
  outputYards: number;
  conditions: NormalizedRuleCondition[];
  rawConditions: Record<string, unknown>;
}

@Injectable()
export class CustomOrderRuleValidatorService {
  normalizeRules(
    rules: Array<{
      priority: number;
      outputYards: string | number;
      isFallback?: boolean;
      conditionsJson: Record<string, unknown>;
    }>,
  ): NormalizedCustomFabricRule[] {
    if (!Array.isArray(rules) || rules.length === 0) {
      throw new BadRequestException('At least one custom fabric rule is required');
    }

    const normalized = rules.map((rule) => {
      const outputYards = Number(rule.outputYards);
      if (!Number.isFinite(outputYards) || outputYards <= 0) {
        throw new BadRequestException('Each custom fabric rule must have a positive yard output');
      }

      const rawConditions =
        rule.conditionsJson && typeof rule.conditionsJson === 'object'
          ? rule.conditionsJson
          : {};

      const conditions = Object.entries(rawConditions)
        .map(([key, value]) => this.normalizeCondition(key, value))
        .sort((left, right) => left.key.localeCompare(right.key));

      return {
        priority: Number(rule.priority),
        isFallback: Boolean(rule.isFallback),
        outputYards,
        conditions,
        rawConditions,
      };
    });

    normalized.sort((left, right) => left.priority - right.priority);
    this.validateRules(normalized);
    return normalized;
  }

  validateRules(rules: NormalizedCustomFabricRule[]) {
    const fallbackRules = rules.filter((rule) => rule.isFallback);
    if (fallbackRules.length !== 1) {
      throw new BadRequestException('Exactly one fallback fabric rule is required');
    }

    const seenPriorities = new Set<number>();
    const seenSignatures = new Set<string>();
    for (const rule of rules) {
      if (!Number.isInteger(rule.priority) || rule.priority < 1) {
        throw new BadRequestException('Custom fabric rule priority must be an integer greater than 0');
      }

      if (seenPriorities.has(rule.priority)) {
        throw new BadRequestException('Custom fabric rules must use unique priorities');
      }
      seenPriorities.add(rule.priority);

      if (rule.isFallback && rule.conditions.length > 0) {
        throw new BadRequestException('Fallback fabric rule cannot define conditions');
      }

      const signature = JSON.stringify({
        fallback: rule.isFallback,
        conditions: rule.conditions,
      });
      if (seenSignatures.has(signature)) {
        throw new BadRequestException('Duplicate custom fabric rules are not allowed');
      }
      seenSignatures.add(signature);
    }
  }

  private normalizeCondition(key: string, value: unknown): NormalizedRuleCondition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`Invalid rule condition for measurement key ${key}`);
    }

    const condition = value as Record<string, unknown>;
    const min = condition.min == null ? undefined : Number(condition.min);
    const max = condition.max == null ? undefined : Number(condition.max);

    if (min != null && !Number.isFinite(min)) {
      throw new BadRequestException(`Invalid minimum rule value for measurement key ${key}`);
    }
    if (max != null && !Number.isFinite(max)) {
      throw new BadRequestException(`Invalid maximum rule value for measurement key ${key}`);
    }
    if (min != null && max != null && min > max) {
      throw new BadRequestException(`Rule condition minimum cannot exceed maximum for ${key}`);
    }

    return { key, min, max };
  }
}
