import { BadRequestException } from '@nestjs/common';
import { SearchService } from './search.service';

jest.mock('src/market/eligibility/market-eligibility', () => ({
  ...jest.requireActual('src/market/eligibility/market-eligibility'),
  isEligibleProduct: () => true,
}));

const parsed = {
  normalizedQuery: 'red agbada',
  attributes: [
    {
      type: 'color',
      value: 'red',
      label: 'Red',
      confidence: 1,
      applied: 'filter',
      text: 'red',
      values: ['red'],
    },
  ],
  residual: 'agbada',
  residualGroups: [['agbada']],
  filters: { colors: ['red'] },
  boosts: {},
  corrections: [],
  truncated: false,
  lexiconVersion: 'lex-1',
};

const row = {
  id: 'product-1',
  name: 'Red Agbada',
  description: null,
  thumbnail: 'https://cdn.invalid/a.jpg',
  images: ['https://cdn.invalid/a.jpg'],
  price: 50000,
  salePrice: 40000,
  effectivePrice: 40000,
  currency: 'NGN',
  slug: 'red-agbada',
  brandId: 'brand-1',
  brandName: 'House',
  brandOwnerId: 'owner-1',
  tier: 0,
  score: '132.4',
  exact: false,
  lowStock: { size: '42', left: 2 },
};

const build = () => {
  const intelligence = {
    understand: jest.fn().mockResolvedValue(parsed),
    page: jest.fn().mockResolvedValue({
      total: 1,
      items: [row],
      facets: { color: [{ value: 'red', count: 1 }] },
    }),
  };
  const prisma = {
    brand: { findUnique: jest.fn() },
    product: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  } as any;
  const service = new SearchService(
    prisma,
    {} as any,
    undefined,
    undefined,
    intelligence as any,
  );
  jest.spyOn(service as any, 'getCachedSearchResult').mockResolvedValue(null);
  const setCache = jest
    .spyOn(service as any, 'setCachedSearchResult')
    .mockResolvedValue(undefined);
  jest.spyOn(service as any, 'recordSearch').mockResolvedValue(undefined);
  jest
    .spyOn(service as any, 'searchBrandsPage')
    .mockResolvedValue({ items: [], total: 0 });
  const legacy = jest
    .spyOn(service as any, 'searchProductsPage')
    .mockResolvedValue({ items: [], total: 0 });
  return { service, intelligence, legacy, setCache, prisma };
};

describe('SearchService lexicon wiring', () => {
  const previous = process.env.SEARCH_LEXICON_V1;
  afterEach(() => {
    if (previous === undefined) delete process.env.SEARCH_LEXICON_V1;
    else process.env.SEARCH_LEXICON_V1 = previous;
  });

  it('keeps the previous path, key and response with the flag off', async () => {
    delete process.env.SEARCH_LEXICON_V1;
    const { service, intelligence, legacy, setCache } = build();
    const response = await service.search({
      query: 'red agbada',
      types: ['product'],
      sort: 'price_asc',
      filters: 'color=red',
      includeFacets: '1',
    });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(intelligence.understand).not.toHaveBeenCalled();
    expect(String(setCache.mock.calls[0][0])).not.toContain('lexicon');
    expect(response).not.toHaveProperty('parsed');
    expect(response).not.toHaveProperty('facets');
    expect(response).not.toHaveProperty('availableSorts');
  });

  it('serves the lexicon product page with parse, sorts and facets', async () => {
    process.env.SEARCH_LEXICON_V1 = 'true';
    const { service, intelligence, legacy, setCache } = build();
    const response = await service.search({
      query: 'red agbada',
      types: ['product'],
      page: 2,
      limit: 10,
      sort: 'price_asc',
      filters: 'size=42',
      includeFacets: '1',
    });
    expect(legacy).not.toHaveBeenCalled();
    const [, request, page] = intelligence.page.mock.calls[0];
    expect(request).toMatchObject({
      sort: 'price_asc',
      filters: { sizes: ['42'] },
      includeFacets: true,
    });
    expect(page).toEqual({
      limit: 10,
      offset: 10,
      brandId: undefined,
      facets: true,
    });
    expect(response.parsed).toEqual({
      attributes: [
        {
          type: 'color',
          value: 'red',
          label: 'Red',
          confidence: 1,
          applied: 'filter',
        },
      ],
      residual: 'agbada',
      corrections: [],
    });
    expect(response.facets).toEqual({ color: [{ value: 'red', count: 1 }] });
    expect(response.availableSorts).toContain('popular');
    expect(response.items[0]).toMatchObject({
      score: 132.4,
      price: 50000,
      salePrice: 40000,
      effectivePrice: 40000,
      metadata: { lowStock: { size: '42', left: 2 }, matchTier: 0 },
    });
    expect(String(setCache.mock.calls[0][0])).toContain(
      ':lexicon:lex-1:price_asc:',
    );
  });

  it('never computes facets for the mixed tab', async () => {
    process.env.SEARCH_LEXICON_V1 = 'true';
    const { service, intelligence } = build();
    const response = await service.search({
      query: 'red agbada',
      types: ['product', 'brand'],
      includeFacets: '1',
    });
    expect(intelligence.page.mock.calls[0][2].facets).toBe(false);
    expect(response).not.toHaveProperty('facets');
  });

  it('does not parse when products are not searched', async () => {
    process.env.SEARCH_LEXICON_V1 = 'true';
    const { service, intelligence } = build();
    await service.search({ query: 'house', types: ['brand'] });
    expect(intelligence.understand).not.toHaveBeenCalled();
  });

  it('rejects an unknown sort before any database read', async () => {
    process.env.SEARCH_LEXICON_V1 = 'true';
    const { service, intelligence } = build();
    await expect(
      service.search({ query: 'agbada', types: ['product'], sort: 'cheap' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(intelligence.page).not.toHaveBeenCalled();
  });

  it('rebuilds a cached lexicon page when a price changed', async () => {
    const { service, prisma } = build();
    const item = {
      id: 'product-1',
      type: 'product',
      title: 'Red Agbada',
      href: '/p/red-agbada',
      score: 1,
      price: 50000,
      salePrice: 40000,
      effectivePrice: 40000,
      metadata: { lowStock: { size: '42', left: 2 } },
    };
    const payload = (salePrice: number) => ({
      title: 'Red Agbada',
      subtitle: 'House',
      description: null,
      imageUrl: 'https://cdn.invalid/a.jpg',
      price: 50000,
      salePrice,
      currency: 'NGN',
      metadata: { brandId: 'brand-1' },
    });
    prisma.product.findMany.mockResolvedValue([{ id: 'product-1' }]);
    const create = jest.spyOn(service as any, 'createProductSuggestionPayload');
    create.mockReturnValue(payload(40000));
    const same = await (service as any).revalidateCommerceItems([item]);
    expect(same).toHaveLength(1);
    expect(same[0].metadata).toEqual({
      lowStock: { size: '42', left: 2 },
      brandId: 'brand-1',
    });
    create.mockReturnValue(payload(35000));
    await expect(
      (service as any).revalidateCommerceItems([item]),
    ).resolves.toHaveLength(0);
  });
});
