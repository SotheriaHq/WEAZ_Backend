import { Injectable, Logger } from '@nestjs/common';

export const MARKET_V2_SURFACES = [
  'HOME',
  'SEE_ALL',
  'CATALOG',
  'SUGGESTIONS',
  'SEARCH',
] as const;
export type MarketV2Surface = (typeof MARKET_V2_SURFACES)[number];
export interface MarketSurfaceFlags {
  readonly pipelineV2Surfaces: readonly MarketV2Surface[];
  readonly invalidSurfaceConfiguration: boolean;
}

/** Empty or malformed rollout configuration preserves all existing V1 routes. */
@Injectable()
export class MarketFlagsService {
  private readonly logger = new Logger(MarketFlagsService.name);
  private reportedConfiguration: string | null = null;

  getConfig(env: NodeJS.ProcessEnv = process.env): MarketSurfaceFlags {
    const raw = env.MARKET_PIPELINE_V2_SURFACES?.trim() ?? '';
    if (!raw)
      return Object.freeze({
        pipelineV2Surfaces: Object.freeze([]),
        invalidSurfaceConfiguration: false,
      });
    if (raw.length > 256) return this.invalid(raw, null);
    const selected = raw.split(',').map((value) => value.trim().toUpperCase());
    const invalidTokens = selected.filter(
      (value) => !MARKET_V2_SURFACES.includes(value as MarketV2Surface),
    );
    if (invalidTokens.length) return this.invalid(raw, invalidTokens);
    return Object.freeze({
      pipelineV2Surfaces: Object.freeze([
        ...new Set(selected),
      ] as MarketV2Surface[]),
      invalidSurfaceConfiguration: false,
    });
  }

  isEnabled(
    surface: MarketV2Surface,
    env: NodeJS.ProcessEnv = process.env,
  ): boolean {
    return this.getConfig(env).pipelineV2Surfaces.includes(surface);
  }

  private invalid(
    raw: string,
    invalidTokens: readonly string[] | null,
  ): MarketSurfaceFlags {
    // Reported once per configured value, not on every routing decision.
    if (this.reportedConfiguration !== raw) {
      this.reportedConfiguration = raw;
      this.logger.warn({
        event: 'market.flags.invalid_surface_configuration',
        variable: 'MARKET_PIPELINE_V2_SURFACES',
        effect: 'ALL_SURFACES_OFF',
        ...(invalidTokens
          ? {
              invalidTokens: [...new Set(invalidTokens)]
                .slice(0, 8)
                .map((token) => token.slice(0, 32)),
            }
          : { reason: 'TOO_LONG', length: raw.length }),
        allowed: MARKET_V2_SURFACES,
      });
    }
    return Object.freeze({
      pipelineV2Surfaces: Object.freeze([]),
      invalidSurfaceConfiguration: true,
    });
  }
}
