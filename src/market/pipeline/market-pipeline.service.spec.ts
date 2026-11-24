import { MarketCatalogReadService } from '../catalog/market-catalog-read.service';
import { MarketCatalogService } from '../catalog/market-catalog.service';
import { MarketPublicMediaService } from '../catalog/market-public-media.service';
import { buildMarketPipelinePage } from './market-pipeline.page';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  MarketPipelineService,
  marketPipelineSpecHash,
} from './market-pipeline.service';
import { pipelineSource } from './market-pipeline.sources';
import { PipelineContext } from './market-pipeline.types';
import { ConfigService } from '@nestjs/config';
import { resolvePipelineSectionSource } from './market-pipeline.section-source';
import { readPipelineSourceSection } from './market-pipeline.section-reader';

jest.mock('./market-pipeline.page', () => ({
  buildMarketPipelinePage: jest.fn(),
}));
jest.mock('./market-pipeline.section-source', () => ({
  resolvePipelineSectionSource: jest.fn(),
}));
jest.mock('./market-pipeline.section-reader', () => ({
  readPipelineSourceSection: jest.fn(),
}));
const build = jest.mocked(buildMarketPipelinePage);
const id = '11111111-1111-4111-8111-111111111111';
const spec = parsePipelineSpec({
  key: 'adire-casual',
  template: 'CATALOG_FILTER',
  status: 'ACTIVE',
  filters: { tags: ['adire'] },
});
function fixture() {
  const catalogue = { getPage: jest.fn().mockResolvedValue({ items: [] }) };
  const service = new MarketPipelineService(
    {} as MarketCatalogReadService,
    {} as MarketPublicMediaService,
    catalogue as unknown as MarketCatalogService,
    undefined,
    {} as ConfigService,
  );
  const section = {
    key: spec.key,
    title: spec.title,
    template: spec.template,
    items: [{ id }],
    viewAll: { availableSorts: ['newest', 'price_asc', 'price_desc'] },
    scope: {
      source: { kind: 'catalog' as const, sort: 'newest' as const, firstPublishedAfter: null },
      fixedFilterLayers: [{ tags: ['adire'] }, { fulfilment: 'READY_TO_WEAR' as const }],
    },
  };
  build.mockResolvedValue({
    public: { sections: [] },
    trusted: { sections: [section] },
  } as never);
  const resolved = {
    original: spec,
    effective: spec,
    source: section.scope.source,
    fixedFilterLayers: section.scope.fixedFilterLayers,
    context: {} as PipelineContext,
    fallbackReason: null,
    candidateCount: 1,
  };
  jest
    .mocked(resolvePipelineSectionSource)
    .mockImplementation(async () => ({
      ...resolved,
      source: section.scope.source,
    }));
  jest
    .mocked(readPipelineSourceSection)
    .mockResolvedValue({
      items: [],
      pagination: { nextCursor: null },
    } as never);
  return { service, catalogue, section, resolved };
}

describe('Market pipeline injectable facade', () => {
  beforeEach(() => jest.clearAllMocks());
  it('delegates full-set filters/source to catalogue without a preview-ID restriction', async () => {
    const { service, catalogue } = fixture();
    const result = await service.getSection({
      key: spec.key,
      specs: [spec],
      viewer: {},
      query: new URLSearchParams('sort=price_asc&color=red'),
    });
    expect(result.kind).toBe('catalogue');
    const [query, viewer, trusted] = catalogue.getPage.mock.calls[0];
    expect(query.get('sort')).toBe('price_asc');
    expect(viewer).toEqual({});
    expect(trusted.scope.source.kind).toBe('catalog');
    expect(trusted.fixedFilters).toEqual({ tags: ['adire'] });
    expect(trusted.scope.filterLayers).toEqual([
      { fulfilment: 'READY_TO_WEAR' },
    ]);
    expect(trusted.scope).not.toHaveProperty('productIds');
    expect(build).not.toHaveBeenCalled();
    expect(resolvePipelineSectionSource).toHaveBeenCalledWith(
      expect.objectContaining({ key: spec.key, viewer: {} }),
    );
  });
  it('uses full-set readers for nonproduct/source-order lists without preview truncation', async () => {
    const { service, catalogue, section, resolved } = fixture();
    section.scope.source = { kind: 'looks' } as never;
    resolved.effective = { ...spec, template: 'LOOKS', sorts: [] };
    const result = await service.getSection({
      key: spec.key,
      specs: [spec],
      viewer: {},
      query: new URLSearchParams(),
    });
    expect(result.kind).toBe('catalogue');
    expect(catalogue.getPage).not.toHaveBeenCalled();
    expect(readPipelineSourceSection).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, viewer: {} }),
    );
  });
  it('rejects a sort outside the effective section allow-list', async () => {
    const { service, catalogue } = fixture();
    await expect(
      service.getSection({
        key: spec.key,
        specs: [spec],
        viewer: {},
        query: new URLSearchParams('sort=most_saved'),
      }),
    ).rejects.toThrow();
    expect(catalogue.getPage).not.toHaveBeenCalled();
  });
  it('changes the validated spec hash when its source filters change', () => {
    expect(marketPipelineSpecHash(spec)).not.toBe(
      marketPipelineSpecHash({ ...spec, filters: { tags: ['aso-oke'] } }),
    );
  });
  it('keeps publication source anchors stable within an epoch for cursor bindings', () => {
    const releases = parsePipelineSpec({
      ...spec,
      template: 'NEW_RELEASES',
      rankingPolicy: 'recency',
      title: 'Fresh Drops',
    });
    const first = {
      asOf: new Date('2026-11-21T12:01:00.000Z'),
    } as PipelineContext;
    const next = {
      asOf: new Date('2026-11-21T13:30:00.000Z'),
    } as PipelineContext;
    expect(pipelineSource(releases, first)).toEqual(
      pipelineSource(releases, next),
    );
  });
});
