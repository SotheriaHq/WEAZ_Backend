import { Injectable } from '@nestjs/common';

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
  getConfig(env: NodeJS.ProcessEnv = process.env): MarketSurfaceFlags {
    const raw = env.MARKET_PIPELINE_V2_SURFACES?.trim() ?? '';
    if (!raw)
      return Object.freeze({
        pipelineV2Surfaces: Object.freeze([]),
        invalidSurfaceConfiguration: false,
      });
    if (raw.length > 256) return this.invalid();
    const selected = raw.split(',').map((value) => value.trim().toUpperCase());
    if (
      selected.some(
        (value) => !MARKET_V2_SURFACES.includes(value as MarketV2Surface),
      )
    )
      return this.invalid();
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

  private invalid(): MarketSurfaceFlags {
    return Object.freeze({
      pipelineV2Surfaces: Object.freeze([]),
      invalidSurfaceConfiguration: true,
    });
  }
}
