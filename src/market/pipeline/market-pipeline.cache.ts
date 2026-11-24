import { createHash } from 'node:crypto';
import { marketFilterHash } from '../catalog/market-filters';
import {
  PipelineContext,
  PipelineSourceRequest,
  PipelineSpec,
} from './market-pipeline.types';

/** A page registers at most 48 source requests (see requestsFor). */
export const PIPELINE_CACHE_MAX_BATCH = 48;

export interface PipelineCachedCandidate {
  readonly id: string;
  readonly score: number;
}
export interface PipelineCandidateCache {
  get(key: string): Promise<readonly PipelineCachedCandidate[] | null>;
  /** One round trip for every key of a page; absent keys are omitted. */
  getMany(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly PipelineCachedCandidate[]>>;
  set(
    key: string,
    rows: readonly PipelineCachedCandidate[],
    ttlSeconds: number,
  ): Promise<void>;
}
/** No actor identifier or suppression/seen result can enter a shared key/value. */
export function pipelineCacheKey(
  spec: PipelineSpec,
  context: PipelineContext,
  request: PipelineSourceRequest,
): string | null {
  if (
    [
      'AFFINITY',
      'RECENTLY_VIEWED',
      'FOLLOWED_BRANDS',
      'REGIONAL_POPULAR',
    ].includes(spec.template)
  )
    return null;
  // Admit only the code-default unfiltered HOME variant. User-created filter/context
  // combinations compute directly and cannot flood Redis configured noeviction.
  if (
    context.surface !== 'HOME' ||
    Object.keys(context.filters).length ||
    context.productId
  )
    return null;
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        spec,
        source: request.source,
        filters: request.fixedFilterLayers.map(marketFilterHash),
        epoch:
          context.epoch?.id ??
          new Date(
            Math.floor(context.asOf.getTime() / 21600000) * 21600000,
          ).toISOString(),
        sourceAsOf: context.epoch?.sourceAsOf ?? null,
      }),
    )
    .digest('hex');
  return `mkt:cand:v2:${digest}`;
}

/** Bounded local fallback, also useful as the contract test implementation. */
export class BoundedPipelineCandidateCache implements PipelineCandidateCache {
  private readonly entries = new Map<
    string,
    { expires: number; rows: readonly PipelineCachedCandidate[] }
  >();
  constructor(
    private readonly maximumEntries = 256,
    private readonly clock = () => Date.now(),
  ) {
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      maximumEntries > 5000
    )
      throw new RangeError('Invalid cache capacity');
  }
  async get(key: string): Promise<readonly PipelineCachedCandidate[] | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return entry.rows.map((row) => ({ ...row }));
  }
  async getMany(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly PipelineCachedCandidate[]>> {
    if (keys.length > PIPELINE_CACHE_MAX_BATCH)
      throw new RangeError('Candidate cache batch too large');
    const found = new Map<string, readonly PipelineCachedCandidate[]>();
    for (const key of new Set(keys)) {
      const rows = await this.get(key);
      if (rows) found.set(key, rows);
    }
    return found;
  }
  async set(
    key: string,
    rows: readonly PipelineCachedCandidate[],
    ttlSeconds: number,
  ): Promise<void> {
    if (
      !/^mkt:cand:v2:[a-f0-9]{64}$/.test(key) ||
      rows.length > 300 ||
      rows.some(
        (row) => !/^[a-f0-9-]{36}$/.test(row.id) || !Number.isFinite(row.score),
      ) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > 120
    )
      throw new RangeError('Invalid candidate cache entry');
    this.entries.delete(key);
    while (this.entries.size >= this.maximumEntries)
      this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, {
      expires: this.clock() + ttlSeconds * 1000,
      rows: rows.map((row) => ({ id: row.id, score: row.score })),
    });
  }
}
