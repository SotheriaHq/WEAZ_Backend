import {
  PipelinePolicy,
  PipelineSort,
  PipelineTemplate,
} from './market-pipeline.types';

interface TemplateDefinition {
  readonly policy: PipelinePolicy;
  readonly entityType:
    | 'PRODUCT'
    | 'BRAND'
    | 'CATEGORY'
    | 'COLLECTION'
    | 'DESIGN';
  readonly sorts: readonly PipelineSort[];
  readonly title: string;
  readonly requiredHistoryHours: number;
  readonly regional: boolean;
}
const productSorts: readonly PipelineSort[] = [
  'newest',
  'price_asc',
  'price_desc',
];
function entry(
  policy: PipelinePolicy,
  title: string,
  extra: Partial<TemplateDefinition> = {},
): TemplateDefinition {
  return {
    policy,
    title,
    entityType: 'PRODUCT',
    sorts: productSorts,
    requiredHistoryHours: 0,
    regional: false,
    ...extra,
  };
}
/** Closed registry: a spec cannot load a class, expression or arbitrary source. */
export const PIPELINE_TEMPLATES: Readonly<
  Record<PipelineTemplate, TemplateDefinition>
> = Object.freeze({
  NEW_RELEASES: entry('recency', 'Fresh Drops'),
  TREND: entry('trend', 'Hot Right Now', {
    sorts: ['trending', ...productSorts],
  }),
  CATALOG_POPULAR: entry('decayed_popularity', 'Popular this month', {
    sorts: ['popular', ...productSorts],
  }),
  STARTER_PICKS: entry('quality_diverse', 'Starter picks'),
  NEW_DESIGNERS: entry('exposure_balanced', 'New designers to watch', {
    entityType: 'BRAND',
    sorts: [],
  }),
  CATEGORY_TILES: entry('admin_order', 'Shop by style', {
    entityType: 'CATEGORY',
    sorts: [],
  }),
  LOOKS: entry('curator_order', 'Shop the look', {
    entityType: 'COLLECTION',
    sorts: [],
  }),
  LOW_STOCK: entry('stock_scarcity', 'Almost gone', {
    sorts: ['price_asc', 'price_desc'],
  }),
  CURATED_LIST: entry('curator_order', 'Style picks of the week', {
    sorts: [],
  }),
  CATALOG_FILTER: entry('recency', 'Explore the Market'),
  SIMILAR_ITEMS: entry('similarity', 'More like this'),
  COMPLEMENTS: entry('curator_order', 'Complete the look', { sorts: [] }),
  FROM_RUNWAY: entry('recency', 'From the Runway', {
    entityType: 'DESIGN',
    sorts: [],
  }),
  AFFINITY: entry('quality_diverse', 'Picked for you', {
    requiredHistoryHours: 720,
  }),
  RECENTLY_VIEWED: entry('recency', 'Still thinking about these', {
    requiredHistoryHours: 168,
  }),
  FOLLOWED_BRANDS: entry('recency', 'More from brands you like', {
    requiredHistoryHours: 720,
  }),
  REGIONAL_POPULAR: entry('decayed_popularity', 'Popular now', {
    regional: true,
  }),
});

export function hasTemplate(value: string): value is PipelineTemplate {
  return Object.prototype.hasOwnProperty.call(PIPELINE_TEMPLATES, value);
}
