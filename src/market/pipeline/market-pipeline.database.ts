import { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CapturedMarketCard,
  hydrateMarketCatalogCards,
} from '../catalog/market-catalog-cards';
import { captureMarketCatalogCardsBatched as captureMarketCatalogCards } from '../catalog/market-catalog-card-batch';
import {
  MarketCatalogViewer,
  marketCatalogOwnerSql,
  createMarketCatalogScope,
} from '../catalog/market-catalog-scope';
import {
  encodeMarketFilters,
  marketFilterHash,
  CanonicalMarketFilters,
} from '../catalog/market-filters';
import { marketProductFiltersSql } from '../catalog/market-filter.sql';
import { pipelineTrendRatioSql } from './market-pipeline.trend';
import {
  MARKET_FEATURE_PARAMETERS,
  parseMarketSnapshotReadSummary,
} from '../intelligence/market-intelligence.contracts';
import {
  pipelineBatchSourcesSql,
  PipelineDatabaseRow,
} from './market-pipeline.database.sql';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import {
  defaultPipelineFallbacks,
  pipelineSource,
  pipelineUnavailableReason,
  resolvePipelineFallback,
} from './market-pipeline.sources';
import {
  scorePipelineCandidates,
  rerankPipelineCandidates,
} from './market-pipeline.ranking';
import {
  PipelineContext,
  PipelineEpoch,
  PipelineHydrated,
  PipelinePorts,
  PipelineSourceRequest,
  PipelineSpec,
} from './market-pipeline.types';

type ReadTx = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'product' | 'fileUpload' | '$executeRaw' | 'filterDimension'
>;
export interface CapturedPipelinePage {
  readonly viewer: MarketCatalogViewer;
  readonly context: PipelineContext;
  readonly specs: readonly PipelineSpec[];
  readonly rows: readonly PipelineDatabaseRow[];
  readonly products: readonly CapturedMarketCard[];
  readonly requests: readonly {
    key: string;
    request: PipelineSourceRequest;
    spec: PipelineSpec;
  }[];
  readonly captureIds: ReadonlySet<string>;
}
export function pipelineRequestKey(request: PipelineSourceRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: request.source,
        filters: marketFilterHash(request.filters),
        fixed: request.fixedFilterLayers.map(marketFilterHash),
        epoch: request.epoch?.id ?? null,
        mode: request.suppressionMode ?? 'viewer',
        // Section identity is required by the final CURRENT suppression gate.
        // Shared SQL pools must not merge two separately hideable sections.
        section: request.sectionKey,
      }),
    )
    .digest('hex');
}

/** Capture the clock and immutable evidence in the enclosing bounded read-only RR transaction. */
export async function readPipelineEpochContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  probe?: {
    readonly filters: CanonicalMarketFilters;
    readonly viewer: MarketCatalogViewer;
  },
): Promise<{
  asOf: Date;
  epoch: PipelineEpoch | null;
  eligibleProductCount?: number;
}> {
  const clocks = await tx.$queryRaw<
    Array<{ asOf: Date; isolation: string; readOnly: string }>
  >`SELECT date_trunc('milliseconds',statement_timestamp()) AS "asOf",current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly"`;
  const capturedClock = clocks[0];
  if (
    !capturedClock ||
    capturedClock.isolation !== 'repeatable read' ||
    capturedClock.readOnly !== 'on' ||
    !(capturedClock.asOf instanceof Date) ||
    !Number.isFinite(capturedClock.asOf.getTime())
  )
    throw new Error('Catalogue read context is required');
  const now = Prisma.sql`clock."asOf"`;
  const rows = await tx.$queryRaw<
    Array<{
      asOf: Date;
      isolation: string;
      readOnly: string;
      epoch:
        | (Omit<PipelineEpoch, 'complete'> & {
            generation: string;
            rowCount: number;
          })
        | null;
      readSummary: string | null;
      eligibleProductCount?: number;
    }>
  >(Prisma.sql`
    WITH clock AS MATERIALIZED(SELECT ${capturedClock.asOf.toISOString()}::timestamptz AS "asOf",current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly"),
    epoch AS (SELECT jsonb_build_object('id',e.id,'generation',e.generation::text,'rowCount',e."rowCount",'epochStart',e."epochStart",'epochEnd',e."epochEnd",'sourceAsOf',e."sourceAsOf",'acceptUntil',e."acceptUntil",
      'featureSchemaVersion',e."featureSchemaVersion",'policyVersion',e."policyVersion",'stateKey',e."stateKey",'status',e.status,
      'intentProductCount',stats.intent_count) AS epoch
    FROM market_feature_state state JOIN market_feature_epochs e ON e.id=state."currentEpochId" AND e."stateKey"=state.key CROSS JOIN clock
    JOIN LATERAL(SELECT count(*)::int AS intent_count FROM (
      SELECT f."productId" FROM market_item_feature_snapshots f JOIN LATERAL(SELECT p.* FROM "Product" p WHERE p."_id"=f."productId" LIMIT 1) p ON true
      WHERE f."epochId"=e.id AND f."sourceFeatureSchemaVersion"=1 AND f."sourcePolicyVersion"=1 AND f."sourceAsOf"<=e."sourceAsOf"
        AND f."sourceAsOf">${now}-interval '2 hours' AND f."decayedPopularity">0 AND f."decayedPopularity"<'Infinity'::float8
        AND f.coverage->'decayedPopularity'->>'completeness'='COMPLETE'
        AND (f.coverage->'decayedPopularity'->>'requiredWindowEnd')::timestamptz=f."sourceAsOf"
        AND (f.coverage->'decayedPopularity'->>'requiredWindowStart')::timestamptz<=f."sourceAsOf"-interval '28 days'
        AND ${marketProductFiltersSql([{}], capturedClock.asOf)} ORDER BY f."decayedPopularity" DESC,f."productId" LIMIT 8) positive) stats ON true
    WHERE state.key='market.features.v1.r1' AND e.status='READY' AND e."featureSchemaVersion"=1 AND e."policyVersion"=1
      AND e.parameters=${JSON.stringify(MARKET_FEATURE_PARAMETERS)}::jsonb
      AND e."readyAt"<=${now} AND e."epochStart"<=${now}
      AND e."sourceAsOf" BETWEEN ${now}-interval '2 hours' AND ${now} AND e."acceptUntil">${now} LIMIT 1)
    SELECT clock.*,(SELECT epoch FROM epoch LIMIT 1) AS epoch,(SELECT value FROM system_config WHERE key='market.features.snapshot') AS "readSummary"
      ${probe ? Prisma.sql`,(SELECT count(*)::int FROM(SELECT 1 FROM "Product" p WHERE ${marketProductFiltersSql([probe.filters], capturedClock.asOf, 'p', createMarketCatalogScope({ key: 'pipeline', version: '1', viewer: probe.viewer }))} LIMIT 8) bounded) AS "eligibleProductCount"` : Prisma.empty}
      FROM clock`);
  const clock = rows[0];
  if (
    !clock ||
    clock.isolation !== 'repeatable read' ||
    clock.readOnly !== 'on' ||
    !(clock.asOf instanceof Date) ||
    !Number.isFinite(clock.asOf.getTime())
  )
    throw new Error('Catalogue read context is required');
  if (
    probe &&
    (!Number.isSafeInteger(clock.eligibleProductCount) ||
      clock.eligibleProductCount! < 0 ||
      clock.eligibleProductCount! > 8)
  )
    throw new Error('Catalogue size proof unavailable');
  let summary: unknown = null;
  try {
    summary = clock.readSummary ? JSON.parse(clock.readSummary) : null;
  } catch {}
  const rawEpoch = clock.epoch;
  const verified = rawEpoch
    ? parseMarketSnapshotReadSummary(
        summary && typeof summary === 'object' && 'readSummary' in summary
          ? summary.readSummary
          : null,
        {
          epochId: rawEpoch.id,
          generation: rawEpoch.generation,
          sourceAsOf: rawEpoch.sourceAsOf,
          acceptUntil: rawEpoch.acceptUntil,
          rows: rawEpoch.rowCount,
        },
      )
    : null;
  const epoch: PipelineEpoch | null = rawEpoch
    ? {
        id: rawEpoch.id,
        epochStart: rawEpoch.epochStart,
        epochEnd: rawEpoch.epochEnd,
        sourceAsOf: rawEpoch.sourceAsOf,
        acceptUntil: rawEpoch.acceptUntil,
        featureSchemaVersion: rawEpoch.featureSchemaVersion,
        policyVersion: rawEpoch.policyVersion,
        stateKey: rawEpoch.stateKey,
        status: rawEpoch.status,
        intentProductCount: rawEpoch.intentProductCount,
        complete: verified?.complete ?? {
          popularity: false,
          trend: false,
          quality: false,
        },
      }
    : null;
  return {
    asOf: clock.asOf,
    epoch,
    ...(probe ? { eligibleProductCount: clock.eligibleProductCount } : {}),
  };
}

function requestsFor(
  specs: readonly PipelineSpec[],
  context: PipelineContext,
): Array<{ key: string; request: PipelineSourceRequest; spec: PipelineSpec }> {
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const result = new Map<
    string,
    { key: string; request: PipelineSourceRequest; spec: PipelineSpec }
  >();
  for (const original of specs) {
    if (
      original.status !== 'ACTIVE' ||
      original.placement.surface !== context.surface
    )
      continue;
    const queue = [{ spec: original, layers: [original.filters], depth: 0 }];
    const tried = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      const label = `${current.spec.key}:${current.spec.template}`;
      if (current.depth > 2 || tried.has(label)) continue;
      tried.add(label);
      const spec = current.spec;
      if (!pipelineUnavailableReason(spec, context)) {
        const windows =
          spec.template === 'NEW_RELEASES'
            ? [
                ...new Set([
                  spec.params.eligibilityWindowDays,
                  Math.max(spec.params.eligibilityWindowDays, 60),
                  90,
                ]),
              ]
            : [spec.params.eligibilityWindowDays];
        for (const days of windows) {
          const request: PipelineSourceRequest = {
            sectionKey: original.key,
            source: pipelineSource(spec, context, days),
            fixedFilterLayers: current.layers,
            filters: context.filters,
            epoch: context.epoch,
            asOf: context.asOf,
            limit: spec.params.candidateLimit,
            signal: context.signal ?? new AbortController().signal,
            suppressionMode:
              context.surface === 'HOME' &&
              !Object.keys(context.filters).length &&
              !context.productId
                ? 'public_pool'
                : 'viewer',
          };
          const key = pipelineRequestKey(request);
          if (!result.has(key)) result.set(key, { key, request, spec });
        }
      }
      for (const key of defaultPipelineFallbacks(spec)) {
        const fallback = resolvePipelineFallback(spec, key, byKey);
        if (fallback)
          queue.push({
            spec: fallback,
            depth: current.depth + 1,
            layers:
              fallback.key === spec.key
                ? current.layers
                : [...current.layers, fallback.filters],
          });
      }
    }
  }
  if (result.size > 48) throw new RangeError('Source batch capacity exceeded');
  return [...result.values()];
}

/** One request-scoped captured batch. No database connection survives into signing/composition. */
export async function captureMarketPipelinePage(
  tx: ReadTx,
  input: {
    readonly specs: readonly unknown[];
    readonly context: PipelineContext;
    readonly viewer: MarketCatalogViewer;
  },
): Promise<CapturedPipelinePage> {
  const specs = input.specs.map(parsePipelineSpec);
  validatePipelineGraph(specs);
  encodeMarketFilters(input.context.filters);
  if (input.context.signal?.aborted) throw new Error('Request ended');
  // A real database deadline covers the combined source query; composition
  // below uses only memory and never abandons a still-running SQL operation.
  if (!Number.isFinite(input.context.deadline))
    await tx.$executeRaw`SET LOCAL statement_timeout='250ms'`;
  const requests = requestsFor(specs, input.context);
  const dimensionEntries = requests.flatMap(({ request }) =>
    [request.filters, ...request.fixedFilterLayers].flatMap((layer) =>
      Object.entries(layer.dimensions ?? {}).map(
        ([slug, values]) =>
          [
            slug,
            values,
            request.source.kind === 'from_runway' ? 'COLLECTION' : 'PRODUCT',
          ] as const,
      ),
    ),
  );
  if (dimensionEntries.length) {
    const dimensions = await tx.$queryRaw<
      Array<{
        slug: string;
        isMulti: boolean;
        appliesTo: string[];
        values: Array<{ slug: string }>;
      }>
    >(Prisma.sql`
      SELECT dimension.slug,dimension."isMulti",dimension."appliesTo",COALESCE(jsonb_agg(jsonb_build_object('slug',value.slug)) FILTER(WHERE value."_id" IS NOT NULL),'[]'::jsonb) AS values
      FROM "FilterDimension" dimension LEFT JOIN "FilterValue" value ON value."dimensionId"=dimension."_id" AND value."isActive"
        AND value.slug IN (${Prisma.join([...new Set(dimensionEntries.flatMap(([, values]) => [...values]))])})
      WHERE dimension.slug IN (${Prisma.join([...new Set(dimensionEntries.map(([slug]) => slug))])}) AND dimension."isActive"
      GROUP BY dimension."_id",dimension.slug,dimension."isMulti",dimension."appliesTo"`);
    const bySlug = new Map(
      dimensions.map((dimension) => [dimension.slug, dimension]),
    );
    for (const [slug, values, entity] of dimensionEntries) {
      const dimension = bySlug.get(slug);
      if (
        !dimension ||
        !dimension.appliesTo.includes(entity) ||
        (!dimension.isMulti && values.length > 1) ||
        values.some(
          (value) => !dimension.values.some((option) => option.slug === value),
        )
      )
        throw new BadRequestException({
          code: 'INVALID_FILTER',
          message:
            'Select active product style details and their allowed values.',
        });
    }
  }
  const rows = requests.length
    ? await tx.$queryRaw<PipelineDatabaseRow[]>(
        pipelineBatchSourcesSql(requests, input.viewer),
      )
    : [];
  if (rows.length > requests.length * 61)
    throw new RangeError('Source batch overflow');
  const rowsByRequest = new Map<string, PipelineDatabaseRow[]>();
  for (const row of rows) {
    const values = rowsByRequest.get(row.requestKey) ?? [];
    values.push(row);
    rowsByRequest.set(row.requestKey, values);
  }
  const preferences = await tx.$queryRaw<
    Array<{
      targets: string[];
      brands: string[];
      categories: string[];
      sections: string[];
      tenure: Record<
        string,
        {
          consecutive: number;
          lastEpochStart: string;
          entryTrendRatio: number | null;
        }
      >;
    }>
  >(Prisma.sql`
    WITH candidates AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.map((row) => ({ id: row.candidate.id, type: row.candidate.entityType, brand: row.candidate.brandId, category: row.candidate.categoryId })))}::jsonb)
      AS selected(id text,type text,brand text,category text)),
    suppressed AS (SELECT DISTINCT s.* FROM user_content_suppressions s WHERE ${marketCatalogOwnerSql(input.viewer)} AND (s."expiresAt" IS NULL OR s."expiresAt">${input.context.asOf.toISOString()}::timestamptz)
      AND (s."sectionKey" IN (${Prisma.join(specs.map((spec) => spec.key).length ? specs.map((spec) => spec.key) : ['__none__'])})
        OR ((s."targetType"='SECTION' OR s."suppressionType"='HIDE_SECTION') AND COALESCE(s."sectionKey",s."targetId") IN (${Prisma.join(specs.map((spec) => spec.key).length ? specs.map((spec) => spec.key) : ['__none__'])}))
        OR EXISTS(SELECT 1 FROM candidates c WHERE (s."targetType"::text=c.type AND s."targetId"=c.id)
          OR COALESCE(s."brandId"::text,s."targetId")=c.brand OR COALESCE(s."categoryId"::text,s."targetId")=c.category))),
    exposure AS (SELECT e."sectionKey",e."productId",e.epoch,
      row_number() OVER(PARTITION BY e."sectionKey",e."productId" ORDER BY e.epoch DESC) AS position,
      max(e.epoch) OVER(PARTITION BY e."sectionKey",e."productId") AS latest
      FROM market_section_exposure e WHERE e.epoch>=${input.context.asOf.toISOString()}::timestamptz-interval '4 days'
        AND e.epoch<${new Date(Math.floor(input.context.asOf.getTime() / 21600000) * 21600000).toISOString()}::timestamptz
        AND e."sectionKey" IN (${Prisma.join(specs.map((spec) => spec.key).length ? specs.map((spec) => spec.key) : ['__none__'])})
        AND EXISTS(SELECT 1 FROM candidates c WHERE c.type='PRODUCT' AND c.id=e."productId"::text)),
    tenure AS (SELECT "sectionKey", "productId", max(latest) AS latest,min(epoch) AS entered,count(*)::int AS consecutive FROM exposure
      WHERE epoch=latest-(position-1)*interval '6 hours' GROUP BY "sectionKey","productId"),
    tenure_evidence AS (SELECT tenure.*,CASE WHEN entry_epoch.id IS NOT NULL THEN ${pipelineTrendRatioSql('entry')} END AS "entryTrendRatio"
      FROM tenure LEFT JOIN market_section_exposure first_exposure ON first_exposure."sectionKey"=tenure."sectionKey" AND first_exposure."productId"=tenure."productId" AND first_exposure.epoch=tenure.entered
      LEFT JOIN market_feature_epochs entry_epoch ON entry_epoch.id=first_exposure."epochId" AND entry_epoch.status='READY' AND entry_epoch."stateKey"='market.features.v1.r1' AND entry_epoch."featureSchemaVersion"=1 AND entry_epoch."policyVersion"=1
      LEFT JOIN market_item_feature_snapshots entry ON entry."epochId"=entry_epoch.id AND entry."productId"=tenure."productId")
    SELECT ARRAY(SELECT s."targetType"::text||':'||s."targetId" FROM suppressed s WHERE s."targetId" IS NOT NULL) AS targets,
      ARRAY(SELECT COALESCE(s."brandId"::text,s."targetId") FROM suppressed s WHERE s."targetType"='BRAND' OR s."suppressionType"='HIDE_BRAND') AS brands,
      ARRAY(SELECT COALESCE(s."categoryId"::text,s."targetId") FROM suppressed s WHERE s."targetType"='CATEGORY' OR s."suppressionType"='HIDE_CATEGORY') AS categories,
      ARRAY(SELECT COALESCE(s."sectionKey",s."targetId") FROM suppressed s WHERE (s."targetType"='SECTION' OR s."suppressionType"='HIDE_SECTION') AND COALESCE(s."sectionKey",s."targetId") IS NOT NULL) AS sections,
      COALESCE((SELECT jsonb_object_agg("sectionKey"||':PRODUCT:'||"productId"::text,jsonb_build_object('consecutive',consecutive,'lastEpochStart',latest,'entryTrendRatio',"entryTrendRatio")) FROM tenure_evidence),'{}'::jsonb) AS tenure`);
  if (!preferences[0]) throw new Error('Suppression context unavailable');
  const preference = preferences[0];
  const context: PipelineContext = {
    ...input.context,
    suppression: {
      targetKeys: new Set(preference.targets),
      brandIds: new Set(preference.brands),
      categoryIds: new Set(preference.categories),
      sectionKeys: new Set(preference.sections),
    },
    tenure: new Map(Object.entries(preference.tenure)),
  };
  const ranked = requests.map(({ key, spec }) =>
    rerankPipelineCandidates(
      scorePipelineCandidates(
        (rowsByRequest.get(key) ?? []).map((row) => row.candidate),
        spec,
        context,
      ),
      spec,
      context,
      { placed: new Map(), repeats: 0 },
    ),
  );
  const captureIds = new Set<string>();
  // Round-robin prefetch avoids allowing the first source to consume all media.
  for (let position = 0; position < 24 && captureIds.size < 61; position++)
    for (const list of ranked) {
      const row = list[position];
      if (row)
        captureIds.add(`${row.candidate.entityType}:${row.candidate.id}`);
      if (captureIds.size === 61) break;
    }
  // Fill unused capture capacity across source pools. Several sections can
  // share one query while rotating same-day ties with different section seeds.
  for (let position = 0; position < 61 && captureIds.size < 61; position++)
    for (const entry of requests) {
      const row = rowsByRequest.get(entry.key)?.[position];
      if (
        row &&
        !context.suppression.targetKeys.has(
          `${row.candidate.entityType}:${row.candidate.id}`,
        ) &&
        (!row.candidate.brandId ||
          !context.suppression.brandIds.has(row.candidate.brandId)) &&
        (!row.candidate.categoryId ||
          !context.suppression.categoryIds.has(row.candidate.categoryId))
      )
        captureIds.add(`${row.candidate.entityType}:${row.candidate.id}`);
      if (captureIds.size === 61) break;
    }
  const productRows = new Map(
    rows
      .filter(
        (row) =>
          row.candidate.entityType === 'PRODUCT' &&
          captureIds.has(`PRODUCT:${row.candidate.id}`),
      )
      .map((row) => [
        row.candidate.id,
        {
          id: row.candidate.id,
          ...(row.amount === null
            ? {}
            : { amount: new Prisma.Decimal(row.amount) }),
        },
      ]),
  );
  const products = await captureMarketCatalogCards(tx, {
    rows: [...productRows.values()],
    asOf: input.context.asOf,
  });
  return {
    context,
    specs,
    requests,
    rows,
    products,
    captureIds,
    viewer: input.viewer,
  };
}

/** At most one original + one variant batch for all product and nonproduct cards. */
export async function resolveCapturedPipelinePorts(
  capture: CapturedPipelinePage,
  uploads: {
    getBatchPublicSignedUrls(ids: string[]): Promise<Map<string, string>>;
    getBatchVariantDisplayUrls(
      ids: string[],
      kind: string,
    ): Promise<Map<string, string>>;
  },
): Promise<PipelinePorts> {
  const otherRows = capture.rows.filter(
    (row) =>
      row.candidate.entityType !== 'PRODUCT' &&
      capture.captureIds.has(
        `${row.candidate.entityType}:${row.candidate.id}`,
      ) &&
      row.fileId,
  );
  const fileIds = [
    ...new Set([
      ...capture.products.flatMap((card) => [
        card.file.id,
        ...(card.logoFileId ? [card.logoFileId] : []),
      ]),
      ...otherRows.map((row) => row.fileId!),
    ]),
  ];
  let originals = new Map<string, string>();
  let variants = new Map<string, string>();
  if (fileIds.length) {
    try {
      originals = await uploads.getBatchPublicSignedUrls(fileIds);
    } catch {
      originals = new Map();
    }
    try {
      if (originals.size)
        variants = await uploads.getBatchVariantDisplayUrls(
          [...originals.keys()],
          'CARD',
        );
    } catch {
      variants = new Map();
    }
  }
  const productItems = await hydrateMarketCatalogCards(capture.products, {
    getBatchPublicSignedUrls: async () => originals,
    getBatchVariantDisplayUrls: async () => variants,
  });
  const hydrated = new Map<string, PipelineHydrated>();
  const products = new Map(
    capture.products.map((card) => [card.product.id, card.product]),
  );
  const sourceRows = new Map(
    capture.rows.map((row) => [
      `${row.candidate.entityType}:${row.candidate.id}`,
      row,
    ]),
  );
  for (const item of productItems)
    hydrated.set(`PRODUCT:${item.id}`, {
      item,
      product: products.get(item.id),
      scarcity: sourceRows.get(`PRODUCT:${item.id}`)?.scarcity,
    });
  for (const row of otherRows) {
    const url = variants.get(row.fileId!) ?? originals.get(row.fileId!);
    if (!url || !row.projection) continue;
    const item = {
      ...row.projection,
      media: {
        url,
        thumbnailUrl: url,
        fileId: row.fileId,
        type: 'IMAGE' as const,
        alt: row.projection.title,
      },
      tags: [...row.candidate.tags],
    };
    hydrated.set(`${item.entityType}:${item.id}`, { item });
  }
  return {
    retrieve: async (request) => {
      if (
        request.signal.aborted ||
        request.asOf.getTime() !== capture.context.asOf.getTime()
      )
        throw new Error('Request context ended');
      const key = pipelineRequestKey(request);
      const known = capture.requests.some((entry) => entry.key === key);
      if (!known) throw new Error('Uncaptured source');
      const cached = request.cachedIds ? new Set(request.cachedIds) : null;
      return capture.rows
        .filter(
          (row) =>
            row.requestKey === key && (!cached || cached.has(row.candidate.id)),
        )
        .map((row) => row.candidate)
        .slice(0, request.limit);
    },
    hydrate: async (candidates, asOf, signal) => {
      if (
        signal.aborted ||
        candidates.length > 24 ||
        asOf.getTime() !== capture.context.asOf.getTime()
      )
        throw new Error('Request context ended');
      return candidates.flatMap((candidate) => {
        const row = hydrated.get(`${candidate.entityType}:${candidate.id}`);
        return row ? [row] : [];
      });
    },
  };
}

/** Fresh MVCC gate after signing, constrained to the globally bounded capture. */
export async function readCurrentPipelineSources(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
  capture: CapturedPipelinePage,
): Promise<readonly PipelineDatabaseRow[]> {
  if (capture.context.signal?.aborted) throw new Error('Request ended');
  if (!Number.isFinite(capture.context.deadline))
    await tx.$executeRaw`SET LOCAL statement_timeout='250ms'`;
  const requests = capture.requests
    .map((entry) => ({
      key: entry.key,
      request: {
        ...entry.request,
        ...(![
          'from_runway',
          'looks',
          'new_designers',
          'category_tiles',
        ].includes(entry.request.source.kind)
          ? {
              capturedCovers: capture.products.map((card) => ({
                productId: card.product.id,
                fileId: card.file.id,
                assetVersion: card.file.assetVersion,
              })),
            }
          : {}),
        cachedIds: capture.rows
          .filter(
            (row) =>
              row.requestKey === entry.key &&
              capture.captureIds.has(
                `${row.candidate.entityType}:${row.candidate.id}`,
              ),
          )
          .map((row) => row.candidate.id),
      },
    }))
    .filter((entry) => entry.request.cachedIds.length);
  if (!requests.length) return [];
  // Always enforce this viewer's CURRENT suppression at the final public gate.
  const viewer = capture.viewer;
  const rows = await tx.$queryRaw<PipelineDatabaseRow[]>(
    pipelineBatchSourcesSql(
      requests.map((entry) => ({
        ...entry,
        request: { ...entry.request, suppressionMode: 'viewer' },
      })),
      viewer,
    ),
  );
  return rows;
}

export async function recheckPipelineSourceMembership(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
  capture: CapturedPipelinePage,
): Promise<ReadonlySet<string>> {
  return new Set(
    (await readCurrentPipelineSources(tx, capture)).map(
      (row) =>
        `${row.requestKey}:${row.candidate.entityType}:${row.candidate.id}`,
    ),
  );
}

export function guardPipelineMembership(
  ports: PipelinePorts,
  allowed: ReadonlySet<string>,
): PipelinePorts {
  const ids = new Set([...allowed].map((key) => key.slice(65)));
  return {
    retrieve: async (request) => {
      const candidates = await ports.retrieve(request);
      // Shared candidates were captured from a global public query. A viewer's
      // current suppression may gate hydration, never rewrite this shared pool.
      return request.suppressionMode === 'public_pool'
        ? candidates
        : candidates.filter((candidate) =>
            allowed.has(
              `${pipelineRequestKey(request)}:${candidate.entityType}:${candidate.id}`,
            ),
          );
    },
    hydrate: async (candidates, asOf, signal, request) =>
      ports.hydrate(
        candidates.filter((candidate) =>
          request
            ? allowed.has(
                `${pipelineRequestKey(request)}:${candidate.entityType}:${candidate.id}`,
              )
            : ids.has(`${candidate.entityType}:${candidate.id}`),
        ),
        asOf,
        signal,
        request,
      ),
  };
}
