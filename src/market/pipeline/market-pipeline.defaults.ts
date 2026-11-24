import { parsePipelineSpec } from './market-pipeline.schema';
import { PipelineSpec, PipelineTemplate } from './market-pipeline.types';

/** Values migrate the existing rails; no client rail needs to invent its own pool. */
export function defaultPipelineSpecs(
  eligibleProductCount?: number,
): readonly PipelineSpec[] {
  if (
    eligibleProductCount !== undefined &&
    (!Number.isSafeInteger(eligibleProductCount) || eligibleProductCount < 0)
  )
    throw new RangeError('Invalid catalogue size');
  function spec(
    key: string,
    template: PipelineTemplate,
    order: number,
    extra: Record<string, unknown> = {},
  ): PipelineSpec {
    return parsePipelineSpec({
      key,
      template,
      status: 'ACTIVE',
      placement: { surface: 'HOME', order },
      ...extra,
    });
  }
  // The facade already has a bounded catalogue first page. A complete short page
  // establishes this count without an additional full-catalogue COUNT query.
  if (eligibleProductCount !== undefined && eligibleProductCount < 8)
    return [
      spec('explore-market', 'CATALOG_FILTER', 0, {
        title: 'Explore the Market',
        capacity: { minItems: 1 },
      }),
    ];
  return [
    spec('hot-right-now', 'TREND', 0),
    spec('fresh-drops', 'NEW_RELEASES', 1),
    spec('picked-for-you', 'AFFINITY', 2),
    spec('new-designers-to-watch', 'NEW_DESIGNERS', 3),
    spec('shop-by-style', 'CATEGORY_TILES', 4, { capacity: { minItems: 3 } }),
    spec('shop-the-look', 'LOOKS', 5),
    spec('almost-gone', 'LOW_STOCK', 6, {
      params: { maxPerBrand: 3 },
      diversity: { pageDedupe: true, allowRepeat: true },
    }),
    spec('style-picks-of-the-week', 'CURATED_LIST', 7, {
      curated: { placementKey: 'STYLE_PICKS' },
    }),
    spec('adire-casual', 'CATALOG_FILTER', 8, {
      title: 'Adire casual',
      filters: { tags: ['adire'] },
      capacity: { minItems: 4 },
    }),
    spec('ready-to-wear', 'CATALOG_FILTER', 9, {
      title: 'Ready to wear',
      filters: { fulfilment: 'READY_TO_WEAR', inStockOnly: true },
    }),
    spec('made-to-order', 'CATALOG_FILTER', 10, {
      title: 'Made to order',
      filters: { fulfilment: 'MADE_TO_ORDER' },
    }),
    spec('from-runway', 'FROM_RUNWAY', 11),
  ];
}
