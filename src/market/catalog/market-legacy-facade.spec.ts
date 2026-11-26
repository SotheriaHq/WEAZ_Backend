import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { StoreController } from '../../store/store.controller';
import { StoreService } from '../../store/store.service';
import { SizeComputationService } from '../../sizing/size-computation.service';
import { MarketFlagsService } from '../market-flags.service';
import { MarketSectionItemDto } from '../dto/market-section.dto';
import {
  MarketCatalogNotStartedException,
  MarketCatalogService,
} from './market-catalog.service';
import { MarketCatalogAdmissionException } from './market-catalog-read.service';
import {
  parseLegacyMarketRoute,
  mapLegacyMarketPage,
  LegacyMarketCataloguePage,
  MarketLegacyFallbackLog,
  MARKET_LEGACY_FALLBACK_LOG_INTERVAL_MS,
} from './market-legacy-facade';

const product = '00000000-0000-0000-0000-000000000001';
const brand = '00000000-0000-0000-0000-000000000002';
const user = '00000000-0000-0000-0000-000000000003';
const collection = '00000000-0000-0000-0000-000000000004';
const file = '00000000-0000-0000-0000-000000000005';
const item = (): MarketSectionItemDto => ({
  id: product,
  sourceId: product,
  sourceType: 'PRODUCT',
  entityType: 'PRODUCT',
  title: 'A complete title',
  subtitle: 'Brand',
  description: 'Description',
  brand: {
    id: brand,
    name: 'Brand',
    logoUrl: 'https://media.example/logo.webp',
  },
  media: {
    url: 'https://media.example/cover.webp',
    thumbnailUrl: 'https://media.example/cover.webp',
    fileId: file,
    type: 'IMAGE',
    alt: 'Cover',
    width: 100,
    height: 150,
    aspectRatio: 2 / 3,
  },
  price: {
    amount: 12000,
    saleAmount: 10000,
    effectiveAmount: 10000,
    currency: 'NGN',
  },
  priceRange: null,
  availability: {
    totalStock: 4,
    customOrderEnabled: true,
    standardCheckoutEnabled: true,
    isOnSale: true,
  },
  category: { id: collection, name: 'Category', slug: 'category' },
  tags: ['adire'],
  stats: { views: 4, threads: 2, products: null },
  target: { type: 'PRODUCT', id: product, key: product, route: '/product' },
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
});
const page = (): LegacyMarketCataloguePage => ({
  items: [item()],
  pagination: {
    limit: 20,
    hasNextPage: true,
    nextCursor: 'signed.cursor',
    reanchored: true,
  },
  total: 43,
  legacyOptions: new Map([
    [
      product,
      {
        sizes: ['M', 'L'],
        colors: ['Red'],
        variants: [
          {
            id: file,
            size: 'M',
            color: 'Red',
            stock: 4,
            price: null,
            sku: null,
            colorHex: null,
          },
        ],
        sizeStock: { M: 4 },
        gallery: [
          {
            url: 'https://media.example/cover.webp',
            fileId: file,
            width: 100,
            height: 150,
            aspectRatio: 2 / 3,
          },
        ],
        filters: [],
        categoryType: null,
      },
    ],
  ]),
});
const query = (value: string) => new URLSearchParams(value);
const parsed = (value: string) => {
  const result = parseLegacyMarketRoute(query(value));
  expect(result.kind).toBe('catalogue');
  if (result.kind !== 'catalogue') throw new Error('Unexpected route');
  return result;
};
const responseCode = (read: () => unknown, code: string) => {
  expect(read).toThrow(
    expect.objectContaining({ response: expect.objectContaining({ code }) }),
  );
};

describe('legacy Market translation', () => {
  it('preserves existing default sort/page size while selecting the canonical reader', () => {
    expect(parsed('').query.toString()).toBe('limit=40&sort=newest');
  });
  it('maps aliases with exact selected values and same-SKU canonical encoding', () => {
    const result = parsed(
      'sortBy=price_asc&limit=12&gender=FEMALE&minPrice=100&maxPrice=25000&colors=red,blue&sizes%5B%5D=42%2C5&sizes%5B%5D=M&tags%5B%5D=adire&isOnSale=yes',
    );
    expect(result.query.get('sort')).toBe('price_asc');
    expect(result.query.get('audience')).toBe('WOMEN');
    expect(result.query.get('price.min')).toBe('100');
    expect(result.query.get('price.max')).toBe('25000');
    expect(result.query.get('color')).toBe('red,blue');
    expect(result.query.getAll('size[]')).toEqual(['42,5', 'M']);
    expect(result.query.getAll('tag[]')).toEqual(['adire']);
    expect(result.query.get('onSale')).toBe('1');
  });
  it.each([
    ['MALE', 'MEN'],
    ['FEMALE', 'WOMEN'],
    ['EVERYBODY', 'UNISEX'],
  ])('translates legacy audience %s', (gender, audience) => {
    expect(parsed(`gender=${gender}`).query.get('audience')).toBe(audience);
  });
  it.each(['onSale=false', 'onSale=0', 'isOnSale=no'])(
    'keeps an off sale-toggle off: %s',
    (raw) => {
      expect(parsed(raw).query.get('onSale')).toBe('0');
    },
  );
  it('preserves the public collection as a trusted scope instead of pretending it is a product category', () => {
    const result = parsed(`collectionId=${collection}`);
    expect(result.collectionId).toBe(collection);
    expect(result.query.has('category')).toBe(false);
    expect(result.query.has('collectionId')).toBe(false);
  });
  it.each([
    'search=gown',
    'q=adire',
    'category=casual',
    'isFeatured=true',
    'isFeatured=false',
    'page=2',
    'limit=120',
    `cursor=${product}`,
    'cursor=24',
  ])('preserves unsupported V1 semantics: %s', (raw) => {
    expect(parseLegacyMarketRoute(query(raw))).toEqual({ kind: 'legacy' });
  });
  it.each([
    'limit=2&limit=3',
    'sortBy=newest&sort=newest',
    'onSale=true&isOnSale=false',
    'search=a&q=a',
    'size=M',
    'sort=popular&unknown=secret',
    'sizes=M&sizes=L',
    'sizes=M&sizes%5B%5D=L',
    'collectionId=not-id',
    'page=1.5',
    'page=0',
    'minPrice=1e5',
    'gender=other',
    'onSale=sometimes',
    'isFeatured=sometimes',
    'tags=invalid%20tag%20%21',
  ])(
    'rejects ambiguous, unknown or invalid input before any reader: %s',
    (raw) => {
      expect(() => parseLegacyMarketRoute(query(raw))).toThrow();
    },
  );
  it('bounds the complete request even if its feature would stay on V1', () => {
    responseCode(
      () => parseLegacyMarketRoute(query('search=' + 'a'.repeat(121))),
      'INVALID_FILTER',
    );
    responseCode(
      () => parseLegacyMarketRoute(query('q=' + 'a'.repeat(17000))),
      'INVALID_FILTER',
    );
    responseCode(
      () => parseLegacyMarketRoute(query('search=x&onSale=invalid')),
      'INVALID_FILTER',
    );
  });
  it('never moves a signed or malformed catalogue cursor into V1', () => {
    const cursor = 'a'.repeat(20) + '.' + 'b'.repeat(43);
    expect(parsed('cursor=' + cursor).query.get('cursor')).toBe(cursor);
    for (const suffix of [
      '&page=2',
      '&search=a',
      '&category=casual',
      '&limit=120',
      '&isFeatured=true',
    ])
      responseCode(
        () => parseLegacyMarketRoute(query('cursor=' + cursor + suffix)),
        'INVALID_FILTER',
      );
    responseCode(
      () => parseLegacyMarketRoute(query('cursor=bad.cursor')),
      'INVALID_CURSOR',
    );
    responseCode(
      () => parseLegacyMarketRoute(query('cursor=')),
      'INVALID_CURSOR',
    );
  });
});

const busy = () =>
  new MarketCatalogNotStartedException('ADMISSION', {
    code: 'CATALOGUE_BUSY',
    message: 'The catalogue is busy. Please try again shortly.',
  });
const unconfigured = () =>
  new MarketCatalogNotStartedException('CURSOR_CONFIGURATION', {
    code: 'CATALOGUE_CURSOR_UNAVAILABLE',
    message: 'The catalogue is updating. Please try again shortly.',
  });

describe('legacy Market card serialization', () => {
  afterEach(() => jest.restoreAllMocks());
  it('maps real current data, signed media and exact total without exposing internal records', () => {
    const source = page();
    const result = mapLegacyMarketPage(source);
    expect(result).toMatchObject({
      total: 43,
      totalPages: 3,
      limit: 20,
      hasNextPage: true,
      nextCursor: 'signed.cursor',
      pagination: { reanchored: true },
    });
    expect(result.items[0]).toMatchObject({
      id: product,
      name: 'A complete title',
      price: 12000,
      salePrice: 10000,
      effectivePrice: 10000,
      brandId: brand,
      brandName: 'Brand',
      brandLogo: 'https://media.example/logo.webp',
      stock: 4,
      totalStock: 4,
      sizes: ['M', 'L'],
      colors: ['Red'],
      variants: [{ id: file, size: 'M', color: 'Red', stock: 4 }],
      sizeStock: { M: 4 },
      customOrderEnabled: true,
      standardCheckoutEnabled: true,
      coverImageId: file,
      images: ['https://media.example/cover.webp'],
      media: [
        {
          fileId: file,
          url: 'https://media.example/cover.webp',
          width: 100,
          height: 150,
        },
      ],
    });
    expect(Object.keys(result)).not.toContain('legacyOptions');
    expect(result.items[0]).not.toHaveProperty('owner');
  });
  it.each([undefined, -1, NaN, 0.5, Infinity])(
    'refuses fabricated or absent totals: %s',
    (total) => {
      responseCode(
        () => mapLegacyMarketPage({ ...page(), total }),
        'CATALOGUE_FACADE_UNAVAILABLE',
      );
    },
  );
  it('refuses a page without selling options instead of silently hiding selectors', () => {
    responseCode(
      () => mapLegacyMarketPage({ ...page(), legacyOptions: undefined }),
      'CATALOGUE_FACADE_UNAVAILABLE',
    );
  });
  it('omits only a card that cannot be serialized completely and reports its ID', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const complete = { ...item(), id: brand };
    const source = page();
    const options = source.legacyOptions!.get(product)!;
    const result = mapLegacyMarketPage({
      ...source,
      items: [item(), complete],
      legacyOptions: new Map([[brand, options]]),
    });
    expect(result.items.map((value) => value.id)).toEqual([brand]);
    expect(result.total).toBe(43);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'market.legacy_facade.items_dropped',
      count: 1,
      productIds: [product],
    });
    for (const broken of [
      { ...item(), price: null },
      { ...item(), media: null },
      { ...item(), availability: null },
      { ...item(), entityType: 'DESIGN' as const },
    ])
      expect(
        mapLegacyMarketPage({
          ...source,
          items: [broken as unknown as MarketSectionItemDto],
        }).items,
      ).toEqual([]);
    expect(
      mapLegacyMarketPage({
        ...source,
        legacyOptions: new Map([[product, { ...options, gallery: [] }]]),
      }).items,
    ).toEqual([]);
  });
  it('retains every signed gallery view and public style details without passing through unknown data', () => {
    const source = page(),
      original = source.legacyOptions!.get(product)!;
    const options = {
      ...original,
      slug: 'public-piece',
      gender: 'EVERYBODY',
      categoryType: {
        id: file,
        categoryId: collection,
        slug: 'public-garment',
        name: 'Public garment',
      },
      filters: [
        {
          dimensionId: brand,
          dimensionSlug: 'fabric',
          dimensionName: 'Fabric',
          valueId: file,
          valueSlug: 'linen',
          valueName: 'Linen',
        },
      ],
      gallery: [
        ...original.gallery!,
        {
          url: 'https://media.example/back.webp',
          fileId: collection,
          width: 100,
          height: 150,
          aspectRatio: 2 / 3,
        },
      ],
      variants: [
        {
          ...original.variants[0],
          price: '8000.00',
          privateSupplierCost: 4000,
        },
      ],
    };
    const result = mapLegacyMarketPage({
      ...source,
      legacyOptions: new Map([[product, options]]),
    }).items[0];
    expect(result.images).toEqual([
      'https://media.example/cover.webp',
      'https://media.example/back.webp',
    ]);
    expect(result.filterSelection).toEqual({ [brand]: [file] });
    expect(result.categoryType?.name).toBe('Public garment');
    expect(result.variants[0].price).toBe(8000);
    expect(result.variants[0]).not.toHaveProperty('privateSupplierCost');
  });
  it('keeps genuine empty results and null optional display fields', () => {
    expect(
      mapLegacyMarketPage({
        ...page(),
        items: [],
        total: 0,
        legacyOptions: new Map(),
      }),
    ).toMatchObject({ items: [], total: 0, totalPages: 0 });
    const original = item();
    original.brand = null;
    original.category = null;
    expect(
      mapLegacyMarketPage({ ...page(), items: [original] }).items[0],
    ).toMatchObject({
      brandId: null,
      brandName: null,
      brandLogo: null,
      category: null,
    });
  });
});

describe('Store Market facade dispatch', () => {
  const fixture = (enabled = true) => {
    const legacy = jest.fn().mockResolvedValue({ legacy: true }),
      canonical = jest.fn().mockResolvedValue(page());
    const controller = new StoreController(
      { getMarketplaceProducts: legacy } as unknown as StoreService,
      {} as SizeComputationService,
      {
        isEnabled: jest.fn().mockReturnValue(enabled),
      } as unknown as MarketFlagsService,
      { getPage: canonical } as unknown as MarketCatalogService,
    );
    const invoke = (url: string, identity?: { id?: string; sub?: string }) => {
      const args = Array(18).fill(undefined);
      args.push({ originalUrl: url, user: identity });
      return controller.getMarketplaceProducts(
        ...(args as Parameters<StoreController['getMarketplaceProducts']>),
      );
    };
    return { legacy, canonical, invoke };
  };
  it('keeps the existing route unchanged while rollout is off', async () => {
    const { legacy, canonical, invoke } = fixture(false);
    await expect(invoke('/products/market?unknown=value')).resolves.toEqual({
      legacy: true,
    });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
  });
  it('rejects a canonical continuation after rollback instead of handing it to the old reader', async () => {
    const { legacy, canonical, invoke } = fixture(false);
    await expect(
      invoke(
        '/products/market?cursor=' + 'a'.repeat(20) + '.' + 'b'.repeat(43),
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
    expect(legacy).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });
  it.each(['/products/market', '/store/products/market'])(
    'routes %s through the shared catalogue and caller-owned scope',
    async (path) => {
      const { legacy, canonical, invoke } = fixture();
      await invoke(`${path}?collectionId=${collection}`, { sub: user });
      expect(legacy).not.toHaveBeenCalled();
      const [raw, viewer, trusted] = canonical.mock.calls[0];
      expect(raw.get('sort')).toBe('newest');
      expect(viewer).toEqual({ userId: user });
      expect(trusted).toMatchObject({
        scope: {
          key: 'catalog',
          viewer: { userId: user },
          collectionId: collection,
        },
        includeTotal: true,
        includeLegacyOptions: true,
      });
    },
  );
  it('does not retry canonical validation or infrastructure failures through V1', async () => {
    const { legacy, canonical, invoke } = fixture();
    const error = new Error('Unavailable');
    canonical.mockRejectedValue(error);
    await expect(invoke('/products/market')).rejects.toBe(error);
    expect(legacy).not.toHaveBeenCalled();
  });
  it.each([
    ['admission refusal', busy],
    ['unavailable cursor configuration', unconfigured],
  ])(
    'serves an unsigned request on V1 after a %s before any database work',
    async (_, refusal) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { legacy, canonical, invoke } = fixture();
      canonical.mockRejectedValue(refusal());
      await expect(
        invoke('/products/market?sortBy=price_asc&gender=MALE', { id: user }),
      ).resolves.toEqual({ legacy: true });
      expect(canonical).toHaveBeenCalledTimes(1);
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'market.legacy_facade.v1_fallback',
          reason: refusal().reason,
        }),
      );
      warn.mockRestore();
    },
  );
  it('keeps a signed continuation on the canonical error even when refused before database work', async () => {
    const { legacy, canonical, invoke } = fixture();
    const cursor = 'a'.repeat(20) + '.' + 'b'.repeat(43);
    for (const refusal of [busy(), unconfigured()]) {
      canonical.mockRejectedValueOnce(refusal);
      await expect(invoke('/products/market?cursor=' + cursor)).rejects.toBe(
        refusal,
      );
    }
    expect(legacy).not.toHaveBeenCalled();
  });
  it('does not fall back for a refusal after capture or for unmapped pages', async () => {
    const { legacy, canonical, invoke } = fixture();
    const afterCapture = new MarketCatalogAdmissionException();
    canonical.mockRejectedValueOnce(afterCapture);
    await expect(invoke('/products/market')).rejects.toBe(afterCapture);
    canonical.mockResolvedValueOnce({ ...page(), total: undefined });
    await expect(invoke('/products/market')).rejects.toMatchObject({
      response: { code: 'CATALOGUE_FACADE_UNAVAILABLE' },
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps feature-incompatible V1 requests on their existing implementation', async () => {
    const { legacy, canonical, invoke } = fixture();
    await expect(
      invoke('/products/market?category=casual&search=adire'),
    ).resolves.toEqual({ legacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
  });
});

describe('legacy Market fallback reporting', () => {
  it('warns once per reason per interval and reports the suppressed count', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    let now = 1000;
    const log = new MarketLegacyFallbackLog(() => now);
    log.record('ADMISSION');
    log.record('ADMISSION');
    log.record('ADMISSION');
    log.record('CURSOR_CONFIGURATION');
    expect(warn).toHaveBeenCalledTimes(2);
    now += MARKET_LEGACY_FALLBACK_LOG_INTERVAL_MS;
    log.record('ADMISSION');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith({
      event: 'market.legacy_facade.v1_fallback',
      reason: 'ADMISSION',
      suppressedSincePreviousWarning: 2,
    });
    warn.mockRestore();
  });
});
