import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { MarketCatalogReadService } from '../catalog/market-catalog-read.service';
import { MarketPublicMediaService } from '../catalog/market-public-media.service';
import { captureMarketReadContext } from '../catalog/market-read-context';
import {
  MarketCatalogViewer,
  marketCatalogViewerContext,
} from '../catalog/market-catalog-scope';
import { captureMarketCatalogCardsBatched as captureMarketCatalogCards } from '../catalog/market-catalog-card-batch';
import {
  CanonicalMarketFilters,
  marketFilterHash,
} from '../catalog/market-filters';
import {
  PipelineContext,
  PipelineSource,
  PipelineSpec,
  PipelineSourceRequest,
} from './market-pipeline.types';
import {
  pipelineBatchSourcesSql,
  pipelineSourceKeysSql,
  PipelineDatabaseRow,
} from './market-pipeline.database.sql';
import {
  CapturedPipelinePage,
  pipelineRequestKey,
} from './market-pipeline.database';
import { MarketPipelineMediaResolver } from './market-pipeline.media';
import {
  PipelineSectionCursorCodec,
  PipelineSectionKey,
  pipelineSectionIdentityHash,
  pipelineSourceKeyOrderSql,
} from './market-pipeline.section-cursor';

export interface PipelineSourcePage {
  readonly revision: string;
  readonly reanchored: boolean;
  readonly rows: readonly { id: string; orderKey: PipelineSectionKey }[];
}
/** Source-native seeking occurs before LIMIT. Mutable ranking uses the approved
 * live-feed client dedupe/refresh contract, never a full-universe fingerprint. */
export function pipelineSourcePageSql(input: {
  request: PipelineSourceRequest;
  viewer: MarketCatalogViewer;
  limit: number;
  after?: PipelineSectionKey;
  revision?: string;
}): Prisma.Sql {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 61)
    throw new RangeError('Invalid source page size');
  const reanchored = input.revision !== undefined && input.revision !== '1';
  const keys = pipelineSourceKeysSql(input.request, input.viewer, {
    limit: input.limit,
    after: reanchored ? undefined : input.after,
  });
  return Prisma.sql`SELECT '1'::text AS revision,${reanchored}::boolean AS reanchored,
    COALESCE(jsonb_agg(jsonb_build_object('id',page.id,'orderKey',page."orderKey") ORDER BY ${pipelineSourceKeyOrderSql(input.request.source, 'page')}),'[]'::jsonb) AS rows FROM (${keys}) page`;
}

export interface ResolvedPipelineSection {
  readonly original: PipelineSpec;
  readonly effective: PipelineSpec;
  readonly source: PipelineSource;
  readonly fixedFilterLayers: readonly CanonicalMarketFilters[];
  readonly context: PipelineContext;
  readonly fallbackReason: string | null;
  readonly candidateCount: number;
  readonly targetFingerprint?: string | null;
}

/** Dedicated source-order reader. Explicit price sorts stay in the catalogue's
 * indexed price fence; neither preview ranking nor preview IDs implement paging. */
export async function readPipelineSourceSection(input: {
  reads: MarketCatalogReadService;
  media: MarketPublicMediaService;
  config: ConfigService;
  resolved: ResolvedPipelineSection;
  viewer: MarketCatalogViewer;
  filters: CanonicalMarketFilters;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
}) {
  const codec = new PipelineSectionCursorCodec(
    input.config.get<string>('MARKET_CURSOR_SECRET') ?? '',
    input.config.get<string>('MARKET_CATALOG_NAMESPACE') ?? '',
    input.config.get<string>('MARKET_CURSOR_SECRET_PREVIOUS') || undefined,
  );
  const authenticated = input.cursor
    ? codec.authenticate(input.cursor)
    : undefined;
  const { resolved } = input;
  const captured = await input.reads.run(async (tx) => {
    const clock = await captureMarketReadContext(tx, false);
    const viewer = await marketCatalogViewerContext(
      tx,
      input.viewer,
      clock.asOf,
    );
    const binding = codec.binding({
      key: resolved.original.key,
      spec: pipelineSectionIdentityHash(resolved.original),
      filters: marketFilterHash(input.filters),
      viewer,
    });
    const sourceHash = pipelineSectionIdentityHash({
      effective: resolved.effective.template,
      source: resolved.source,
      fixed: resolved.fixedFilterLayers.map(marketFilterHash),
      epoch: resolved.context.epoch?.id ?? null,
      target: resolved.targetFingerprint ?? null,
    });
    // Identity/filter binding is checked before the full-set source query. A
    // valid old source revision is handled by SQL as an explicit reanchor.
    const preliminary = authenticated
      ? codec.decode(
          input.cursor!,
          binding,
          authenticated.revision,
          clock.asOf.getTime(),
        )
      : undefined;
    const request: PipelineSourceRequest = {
      sectionKey: resolved.original.key,
      source: resolved.source,
      fixedFilterLayers: resolved.fixedFilterLayers,
      filters: input.filters,
      asOf: clock.asOf,
      epoch: resolved.context.epoch,
      limit: 61,
      signal: input.signal ?? new AbortController().signal,
      suppressionMode: 'viewer',
    };
    const dimensions = [input.filters, ...resolved.fixedFilterLayers].flatMap(
      (layer) => Object.entries(layer.dimensions ?? {}),
    );
    if (dimensions.length) {
      const active = await tx.$queryRaw<
        Array<{ slug: string; isMulti: boolean; values: string[] }>
      >(Prisma.sql`SELECT d.slug,d."isMulti",COALESCE(array_agg(v.slug) FILTER(WHERE v."_id" IS NOT NULL),ARRAY[]::text[]) AS values
        FROM "FilterDimension" d LEFT JOIN "FilterValue" v ON v."dimensionId"=d."_id" AND v."isActive" AND v.slug IN (${Prisma.join([...new Set(dimensions.flatMap(([, values]) => values))])})
        WHERE d.slug IN (${Prisma.join([...new Set(dimensions.map(([slug]) => slug))])}) AND d."isActive" AND ${resolved.source.kind === 'from_runway' ? 'COLLECTION' : 'PRODUCT'}=ANY(d."appliesTo") GROUP BY d."_id",d.slug,d."isMulti"`);
      if (
        dimensions.some(([slug, values]) => {
          const row = active.find((value) => value.slug === slug);
          return (
            !row ||
            (!row.isMulti && values.length > 1) ||
            values.some((value) => !row.values.includes(value))
          );
        })
      )
        throw new BadRequestException({
          code: 'INVALID_FILTER',
          message: 'Select active style details and their allowed values.',
        });
    }
    const usable =
      authenticated &&
      preliminary?.kind === 'valid' &&
      authenticated.sourceHash === sourceHash &&
      authenticated.namespace ===
        input.config.get<string>('MARKET_CATALOG_NAMESPACE') &&
      authenticated.expiresAt > clock.asOf.getTime() &&
      authenticated.asOf <= clock.asOf.getTime() + 30000;
    const results = await tx.$queryRaw<PipelineSourcePage[]>(
      pipelineSourcePageSql({
        request,
        viewer: input.viewer,
        limit: Math.min(61, input.limit * 2 + 1),
        ...(usable
          ? { after: authenticated.key, revision: authenticated.revision }
          : {}),
      }),
    );
    const keys = results[0];
    if (!keys) throw new Error('Source page unavailable');
    const requestKey = pipelineRequestKey(request);
    const rows = keys.rows.length
      ? await tx.$queryRaw<PipelineDatabaseRow[]>(
          pipelineBatchSourcesSql(
            [
              {
                key: requestKey,
                request: {
                  ...request,
                  cachedIds: keys.rows.map((row) => row.id),
                },
              },
            ],
            input.viewer,
          ),
        )
      : [];
    const byId = new Map(rows.map((row) => [row.candidate.id, row]));
    const orderedRows = keys.rows.flatMap((key) => {
      const row = byId.get(key.id);
      return row ? [{ ...row, orderKey: key.orderKey }] : [];
    });
    const products = await captureMarketCatalogCards(tx, {
      rows: orderedRows
        .filter((row) => row.candidate.entityType === 'PRODUCT')
        .map((row) => ({
          id: row.candidate.id,
          ...(row.amount === null
            ? {}
            : { amount: new Prisma.Decimal(row.amount) }),
        })),
      asOf: clock.asOf,
    });
    const context = {
      ...resolved.context,
      asOf: clock.asOf,
      filters: input.filters,
      signal: input.signal,
    };
    const capture: CapturedPipelinePage = {
      context,
      specs: [resolved.effective],
      requests: [{ key: requestKey, request, spec: resolved.effective }],
      rows: orderedRows,
      products,
      captureIds: new Set(
        orderedRows.map(
          (row) => `${row.candidate.entityType}:${row.candidate.id}`,
        ),
      ),
      viewer: input.viewer,
    };
    return {
      capture,
      keys,
      binding,
      sourceHash,
      reanchored: keys.reanchored || Boolean(authenticated && !usable),
      asOf: clock.asOf,
    };
  });
  const ports = await new MarketPipelineMediaResolver(input.media).resolve(
    captured.capture,
  );
  const hydrated = [];
  for (let offset = 0; offset < captured.capture.rows.length; offset += 24)
    hydrated.push(
      ...(await ports.hydrate(
        captured.capture.rows
          .slice(offset, offset + 24)
          .map((row) => row.candidate),
        captured.asOf,
        input.signal ?? new AbortController().signal,
        captured.capture.requests[0].request,
      )),
    );
  const byId = new Map(hydrated.map((row) => [row.item.id, row.item]));
  const available = captured.capture.rows.filter((row) =>
    byId.has(row.candidate.id),
  );
  const selected = available.slice(0, input.limit);
  const hasExtra = available.length > input.limit;
  const rawFull =
    captured.keys.rows.length === Math.min(61, input.limit * 2 + 1);
  const last = hasExtra
    ? selected[selected.length - 1]
    : captured.capture.rows[captured.capture.rows.length - 1];
  const hasNext = Boolean(last && (hasExtra || rawFull));
  const nextCursor = hasNext
    ? codec.encode(
        codec.state({
          binding: captured.binding,
          sourceHash: captured.sourceHash,
          revision: captured.keys.revision,
          asOf: captured.asOf.getTime(),
          expiresAt: Math.min(
            captured.asOf.getTime() + 21600000,
            (Math.floor(captured.asOf.getTime() / 21600000) + 1) * 21600000,
          ),
          key: last.orderKey!,
        }),
      )
    : null;
  return {
    items: selected.map((row) => byId.get(row.candidate.id)!),
    pagination: {
      limit: input.limit,
      hasNextPage: hasNext,
      nextCursor,
      reanchored: captured.reanchored,
    },
    appliedFilters: input.filters,
    availableSorts: resolved.effective.sorts,
    sort: { requested: 'source', effective: 'source' },
    meta: {
      asOf: captured.asOf.toISOString(),
      notice: captured.reanchored ? 'Updated' : null,
      fallbackReason: resolved.fallbackReason,
      ordering: 'LIVE_SOURCE' as const,
      updateBehavior: 'DEDUPE_AND_REFRESH' as const,
    },
  };
}
