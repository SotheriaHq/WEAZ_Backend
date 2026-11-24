import { Prisma } from '@prisma/client';
import { assertMarketReadDeadline } from '../catalog/market-catalog-read.service';
import {
  MarketCatalogViewer,
  createMarketCatalogScope,
} from '../catalog/market-catalog-scope';
import { CanonicalMarketFilters } from '../catalog/market-filters';
import { defaultPipelineSpecs } from './market-pipeline.defaults';
import { PipelineCandidateCache } from './market-pipeline.cache';
import {
  MarketPipelineComposer,
  PIPELINE_PAGE_TIMEOUT_MS,
} from './market-pipeline.composer';
import {
  PIPELINE_CACHE_WAIT_MS,
  PipelineCacheWrite,
  captureMarketPipelinePage,
  readPipelineEpochContext,
} from './market-pipeline.database';
import {
  createPipelineExposureReceipt,
  serializePipelinePage,
} from './market-pipeline.delivery';
import {
  PipelineContext,
  PipelineSurface,
  PipelinePorts,
} from './market-pipeline.types';
import { PipelineMediaResolver } from './market-pipeline.media';

/** Bounded best-effort shared-pool writes; never fails or delays a page beyond the wait. */
export async function writePipelineCandidateCache(
  cache: PipelineCandidateCache | undefined,
  writes: readonly PipelineCacheWrite[],
): Promise<void> {
  if (!cache || !writes.length) return;
  await Promise.allSettled(
    writes.map(async (write) => {
      const operation = cache.set(write.key, write.rows, write.ttlSeconds);
      operation.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, PIPELINE_CACHE_WAIT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
}

export interface PipelineReadRunner {
  run<T>(
    reader: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { deadline?: number; signal?: AbortSignal },
  ): Promise<T>;
}

/** Complete public page builder; module/controllers keep surface selection default-off. */
export async function buildMarketPipelinePage(input: {
  readonly read: PipelineReadRunner;
  readonly media: PipelineMediaResolver;
  readonly specs: readonly unknown[];
  readonly useDefaultSpecs?: boolean;
  readonly viewer: MarketCatalogViewer;
  readonly surface: PipelineSurface;
  readonly filters: CanonicalMarketFilters;
  readonly productId?: string;
  readonly signal?: AbortSignal;
  readonly sectionLimit?: number;
  readonly cache?: PipelineCandidateCache;
}) {
  if (
    input.sectionLimit !== undefined &&
    (!Number.isInteger(input.sectionLimit) ||
      input.sectionLimit < 1 ||
      input.sectionLimit > 8)
  )
    throw new RangeError('Invalid section limit');
  const deadline = performance.now() + PIPELINE_PAGE_TIMEOUT_MS;
  // Reuse the trusted scope boundary to validate identity; no body-supplied actor.
  createMarketCatalogScope({
    key: 'pipeline',
    version: '1',
    viewer: input.viewer,
  });
  const capture = await input.read.run(
    async (tx) => {
      // The deadline-aware runner already established the stricter budget.
      if (!Number.isFinite(deadline))
        await tx.$executeRaw`SET LOCAL statement_timeout='250ms'`;
      const epoch = await readPipelineEpochContext(
        tx,
        input.useDefaultSpecs
          ? { filters: input.filters, viewer: input.viewer }
          : undefined,
      );
      const context: PipelineContext = {
        deadline,
        ...epoch,
        surface: input.surface,
        signedIn: Boolean(input.viewer.userId),
        filters: input.filters,
        ...(input.productId ? { productId: input.productId } : {}),
        signal: input.signal,
        retentionHours: 24,
        personalEnabled: false,
        regionalEnabled: false,
        suppression: {
          targetKeys: new Set(),
          brandIds: new Set(),
          categoryIds: new Set(),
          sectionKeys: new Set(),
        },
        tenure: new Map(),
      };
      const specs = input.useDefaultSpecs
        ? defaultPipelineSpecs(epoch.eligibleProductCount)
        : input.specs;
      return captureMarketPipelinePage(tx, {
        specs,
        context,
        viewer: input.viewer,
        cache: input.cache,
        sectionLimit: input.sectionLimit,
      });
    },
    { deadline, signal: input.signal },
  );
  assertMarketReadDeadline({ deadline, signal: input.signal });
  let capturedPorts: PipelinePorts;
  let mediaUnavailable = false;
  // Cache writes run beside media authorization, after the read transaction
  // has released its connection. Each write is bounded; failures are misses.
  const [media] = await Promise.allSettled([
    input.media.resolve(capture),
    writePipelineCandidateCache(input.cache, capture.cacheWrites),
  ]);
  if (media.status === 'fulfilled') capturedPorts = media.value;
  else {
    mediaUnavailable = true;
    capturedPorts = { retrieve: async () => [], hydrate: async () => [] };
  }
  const page = await new MarketPipelineComposer(capturedPorts, {
    sectionLimit: input.sectionLimit,
  }).compose(capture.specs, capture.context);
  if (mediaUnavailable) page.metadata.partial = true;
  page.sections = page.sections.slice(0, input.sectionLimit ?? 8);
  assertMarketReadDeadline({ deadline, signal: input.signal });
  return {
    public: serializePipelinePage(page),
    trusted: page,
    exposureReceipt: createPipelineExposureReceipt(
      page.sections,
      capture.context,
    ),
    context: capture.context,
  };
}
