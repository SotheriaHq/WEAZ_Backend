import { Injectable } from '@nestjs/common';

export type MarketRankingConfig = {
  enabled: boolean;
  shadowMode: boolean;
  sectionKeys: string[];
  maxPersonalizedSections: number;
  fallbackDeterministic: boolean;
  explorationPercent: number;
  brandMaxShare: number;
  aggregateTimeoutMs: number;
};

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off']);
const SECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

@Injectable()
export class MarketRankingConfigService {
  getConfig(env: NodeJS.ProcessEnv = process.env): MarketRankingConfig {
    return {
      enabled: this.readBoolean(env.MARKET_RANKING_ENABLED, false),
      shadowMode: this.readBoolean(env.MARKET_RANKING_SHADOW_MODE, true),
      sectionKeys: this.readSectionKeys(env.MARKET_RANKING_SECTION_KEYS),
      maxPersonalizedSections: this.readInteger(
        env.MARKET_RANKING_MAX_PERSONALIZED_SECTIONS,
        1,
        1,
        3,
      ),
      fallbackDeterministic: this.readBoolean(
        env.MARKET_RANKING_FALLBACK_DETERMINISTIC,
        true,
      ),
      explorationPercent: this.readInteger(
        env.MARKET_RANKING_EXPLORATION_PERCENT,
        10,
        0,
        25,
      ),
      brandMaxShare: this.readInteger(
        env.MARKET_RANKING_BRAND_MAX_SHARE,
        35,
        10,
        50,
      ),
      aggregateTimeoutMs: this.readInteger(
        env.MARKET_RANKING_AGGREGATE_TIMEOUT_MS,
        150,
        25,
        500,
      ),
    };
  }

  private readBoolean(value: string | undefined, fallback: boolean): boolean {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (BOOLEAN_TRUE.has(normalized)) return true;
    if (BOOLEAN_FALSE.has(normalized)) return false;
    return fallback;
  }

  private readInteger(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, min, max);
  }

  private readSectionKeys(value: string | undefined): string[] {
    const seen = new Set<string>();
    const normalized = String(value ?? '')
      .split(',')
      .map((key) => key.trim().toLowerCase())
      .filter((key) => SECTION_KEY_PATTERN.test(key));

    for (const key of normalized) {
      seen.add(key);
      if (seen.size >= 20) break;
    }

    return Array.from(seen);
  }
}
