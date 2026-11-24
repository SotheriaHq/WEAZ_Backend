import { createHash } from 'node:crypto';
import {
  PipelineCandidate,
  PipelineContext,
  PipelineScoredCandidate,
  PipelineSpec,
} from './market-pipeline.types';

export function pipelineSeed(...parts: readonly string[]): number {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest()
    .readUInt32BE(0);
}
const finite = (value: number | null): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const idOrder = (a: PipelineCandidate, b: PipelineCandidate) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function percentile(
  candidates: readonly PipelineCandidate[],
  get: (candidate: PipelineCandidate) => number | null,
): Map<string, number | null> {
  const values = candidates
    .map(get)
    .filter(finite)
    .sort((a, b) => a - b);
  return new Map(
    candidates.map((candidate) => {
      const value = get(candidate);
      // Equal values share a percentile; input order never decides a score.
      const rank = finite(value)
        ? values.findIndex((item) => item === value)
        : -1;
      return [
        candidate.id,
        rank < 0 ? null : values.length <= 1 ? 1 : rank / (values.length - 1),
      ];
    }),
  );
}
export function candidateSimilarity(
  a: PipelineCandidate,
  b: PipelineCandidate,
): number {
  function jaccard(left: readonly string[], right: readonly string[]): number {
    const x = new Set(left);
    const y = new Set(right);
    const union = new Set([...x, ...y]);
    return union.size
      ? [...x].filter((value) => y.has(value)).length / union.size
      : 0;
  }
  return (
    0.3 * Number(Boolean(a.categoryId && a.categoryId === b.categoryId)) +
    0.25 *
      Number(
        Boolean(a.categoryTypeId && a.categoryTypeId === b.categoryTypeId),
      ) +
    0.2 * jaccard(a.dimensions, b.dimensions) +
    0.15 * jaccard(a.tags, b.tags) +
    0.1 *
      (typeof a.effectivePriceAmount === 'number' &&
      typeof b.effectivePriceAmount === 'number' &&
      a.effectivePriceAmount > 0 &&
      b.effectivePriceAmount > 0
        ? 1 -
          Math.min(
            1,
            Math.abs(a.effectivePriceAmount - b.effectivePriceAmount) /
              Math.max(a.effectivePriceAmount, b.effectivePriceAmount),
          )
        : 0)
  );
}

/** Scores only the bounded preview pool. See All is always the WP03 full-set reader. */
export function scorePipelineCandidates(
  candidates: readonly PipelineCandidate[],
  spec: PipelineSpec,
  context: PipelineContext,
): PipelineScoredCandidate[] {
  const popularity = percentile(
    candidates,
    (candidate) => candidate.features.popularity,
  );
  const quality = percentile(
    candidates,
    (candidate) => candidate.features.quality,
  );
  const intent = percentile(
    candidates,
    (candidate) => candidate.features.intent7d,
  );
  const epoch =
    context.epoch?.epochStart ??
    new Date(
      Math.floor(context.asOf.getTime() / 21600000) * 21600000,
    ).toISOString();
  const freshness = (candidate: PipelineCandidate) =>
    candidate.firstPublishedAt
      ? 2 **
        (-Math.max(
          0,
          context.asOf.getTime() - Date.parse(candidate.firstPublishedAt),
        ) /
          86400000 /
          14)
      : 0;
  const rows: PipelineScoredCandidate[] = [];
  const optional = (
    value: number | null | undefined,
    weight: number,
  ): number => (finite(value ?? null) ? value! * weight : 0);
  for (const candidate of candidates) {
    const feature = candidate.features;
    let score: number | null = null;
    switch (spec.rankingPolicy) {
      case 'recency':
        score = candidate.firstPublishedAt
          ? Date.parse(candidate.firstPublishedAt)
          : null;
        break;
      case 'decayed_popularity':
        if (finite(feature.popularity) && finite(feature.quality))
          score =
            0.7 * popularity.get(candidate.id)! +
            0.2 * quality.get(candidate.id)! +
            0.1 * freshness(candidate);
        break;
      case 'trend':
        if (
          feature.trendEligible &&
          finite(feature.trend) &&
          finite(feature.actors7d) &&
          feature.actors7d >= spec.params.evidenceFloorActors
        )
          score = feature.trend;
        break;
      case 'quality_diverse':
        if (finite(feature.quality) && finite(feature.popularity))
          score =
            0.5 * quality.get(candidate.id)! +
            0.3 * freshness(candidate) +
            0.2 * popularity.get(candidate.id)!;
        break;
      case 'stock_scarcity':
        if (
          finite(feature.minStock) &&
          feature.minStock >= 1 &&
          feature.minStock <= spec.params.lowStockThreshold
        )
          score =
            0.6 * (1 - feature.minStock / 4) +
            optional(intent.get(candidate.id), 0.4);
        break;
      case 'similarity':
        if (
          finite(feature.similarity) &&
          feature.similarity >= 0 &&
          feature.similarity <= 1
        )
          score = feature.similarity;
        break;
      case 'admin_order':
      case 'curator_order':
        score = -feature.sourceOrder;
        break;
      case 'exposure_balanced':
        score =
          -feature.sourceOrder -
          pipelineSeed(spec.key, epoch, candidate.id) / 4294967296;
        break;
    }
    if (score === null || !Number.isFinite(score)) continue;
    rows.push({
      candidate,
      score,
      explore: false,
      samplingProbability: null,
      repeatOf: null,
    });
  }
  return rows.sort((a, b) => {
    if (spec.rankingPolicy === 'recency') {
      const sameDay =
        a.candidate.firstPublishedAt?.slice(0, 10) ===
        b.candidate.firstPublishedAt?.slice(0, 10);
      if (sameDay)
        return (
          pipelineSeed(spec.key, epoch, a.candidate.id) -
            pipelineSeed(spec.key, epoch, b.candidate.id) ||
          idOrder(a.candidate, b.candidate)
        );
    }
    return (
      b.score - a.score ||
      (spec.rankingPolicy === 'similarity'
        ? (b.candidate.features.quality ?? -Infinity) -
            (a.candidate.features.quality ?? -Infinity) || 0
        : 0) ||
      (spec.rankingPolicy === 'trend'
        ? (b.candidate.features.popularity ?? 0) -
          (a.candidate.features.popularity ?? 0)
        : 0) ||
      idOrder(a.candidate, b.candidate)
    );
  });
}

export interface PipelinePageState {
  readonly placed: ReadonlyMap<string, string>;
  readonly repeats: number;
}
export function rerankPipelineCandidates(
  rows: readonly PipelineScoredCandidate[],
  spec: PipelineSpec,
  context: PipelineContext,
  page: PipelinePageState,
): PipelineScoredCandidate[] {
  const epochStart =
    context.epoch?.epochStart ??
    new Date(
      Math.floor(context.asOf.getTime() / 21600000) * 21600000,
    ).toISOString();
  const epochTime = Date.parse(epochStart);
  const unique = new Set<string>();
  const pool = rows.filter((row) => {
    const item = row.candidate;
    const key = `${item.entityType}:${item.id}`;
    if (unique.has(key)) return false;
    unique.add(key);
    if (
      context.suppression.targetKeys.has(key) ||
      (item.brandId && context.suppression.brandIds.has(item.brandId)) ||
      (item.categoryId && context.suppression.categoryIds.has(item.categoryId))
    )
      return false;
    const tenure = context.tenure.get(`${spec.key}:${key}`);
    if (
      tenure &&
      ['TREND', 'CATALOG_POPULAR', 'STARTER_PICKS'].includes(spec.template)
    ) {
      const elapsed =
        (epochTime - Date.parse(tenure.lastEpochStart)) / 21600000;
      if (
        tenure.consecutive >= spec.params.maxTenureEpochs &&
        elapsed >= 0 &&
        elapsed <= spec.params.reentryCooldownEpochs &&
        !(
          spec.template === 'TREND' &&
          finite(tenure.entryTrendRatio) &&
          tenure.entryTrendRatio > 0 &&
          finite(item.features.trendRatio) &&
          item.features.trendRatio >= tenure.entryTrendRatio * 1.5
        )
      )
        return false;
    }
    return true;
  });
  const selected: PipelineScoredCandidate[] = [];
  const brands = new Map<string, number>();
  const categories = new Map<string, number>();
  let repeats = page.repeats;
  const target = Math.min(spec.capacity.preview * 2, pool.length);
  const primary = spec.capacity.preview;
  const explorationSlots = Math.min(
    Math.floor(primary * 0.25),
    Math.round((primary * spec.params.explorationShare) / 100),
  );
  let randomCounter = 0;
  while (pool.length && selected.length < target) {
    const permitted = pool.filter((row) => {
      const item = row.candidate;
      const previous = page.placed.get(`${item.entityType}:${item.id}`);
      if (
        previous &&
        spec.diversity.pageDedupe &&
        (!spec.diversity.allowRepeat || repeats >= 2 || selected.length < 2)
      )
        return false;
      if (
        item.brandId &&
        (brands.get(item.brandId) ?? 0) >= spec.params.maxPerBrand
      )
        return false;
      if (
        item.categoryId &&
        (categories.get(item.categoryId) ?? 0) >= spec.params.maxPerCategory
      )
        return false;
      return true;
    });
    if (!permitted.length) break;
    let chosen = permitted[0];
    let probability: number | null = null;
    let explore = false;
    const designerCount = selected.filter(
      (row) =>
        row.candidate.brandCreatedAt &&
        context.asOf.getTime() - Date.parse(row.candidate.brandCreatedAt) <=
          180 * 86400000,
    ).length;
    const designerSlot =
      selected.length < primary &&
      selected.length >= primary - spec.params.newDesignerSlots &&
      designerCount < spec.params.newDesignerSlots;
    const newDesigners = permitted.filter(
      (row) =>
        row.candidate.brandCreatedAt &&
        Date.parse(row.candidate.brandCreatedAt) <= context.asOf.getTime() &&
        context.asOf.getTime() - Date.parse(row.candidate.brandCreatedAt) <=
          180 * 86400000,
    );
    if (designerSlot && newDesigners.length) chosen = newDesigners[0];
    else if (
      selected.length < primary &&
      selected.length >= primary - explorationSlots
    ) {
      const tail = permitted.filter(
        (row) =>
          rows.indexOf(row) >= primary && rows.indexOf(row) < primary * 3,
      );
      if (tail.length) {
        const min = Math.min(...tail.map((row) => row.score));
        const weights = tail.map((row) =>
          Math.max(0.000001, row.score - min + 0.000001),
        );
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        let draw =
          (pipelineSeed(spec.key, epochStart, String(randomCounter++)) /
            4294967296) *
          total;
        let index = 0;
        for (; index < tail.length - 1; index++) {
          draw -= weights[index];
          if (draw < 0) break;
        }
        chosen = tail[index];
        probability = weights[index] / total;
        explore = true;
      }
    } else if (
      spec.rankingPolicy === 'quality_diverse' ||
      spec.rankingPolicy === 'trend'
    ) {
      let best = -Infinity;
      const minimum = Math.min(...rows.map((row) => row.score));
      const maximum = Math.max(...rows.map((row) => row.score));
      for (let i = 0; i < permitted.length; i++) {
        const row = permitted[i];
        const relevance =
          maximum === minimum ? 1 : (row.score - minimum) / (maximum - minimum);
        const similarity = Math.max(
          0,
          ...selected.map((previous) =>
            candidateSimilarity(row.candidate, previous.candidate),
          ),
        );
        const score = 0.7 * relevance - 0.3 * similarity;
        if (score > best) {
          chosen = row;
          best = score;
        }
      }
    }
    const item = chosen.candidate;
    const previous = spec.diversity.pageDedupe
      ? page.placed.get(`${item.entityType}:${item.id}`)
      : undefined;
    selected.push({
      ...chosen,
      explore,
      samplingProbability: probability,
      repeatOf: previous ?? null,
    });
    if (previous) repeats++;
    if (item.brandId)
      brands.set(item.brandId, (brands.get(item.brandId) ?? 0) + 1);
    if (item.categoryId)
      categories.set(
        item.categoryId,
        (categories.get(item.categoryId) ?? 0) + 1,
      );
    pool.splice(pool.indexOf(chosen), 1);
  }
  return selected;
}
