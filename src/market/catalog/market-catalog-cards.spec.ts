import { ContentMediaViewSlot, Prisma } from '@prisma/client';
import {
  captureMarketCatalogCards,
  CapturedMarketCard,
  hydrateMarketCatalogCards,
} from './market-catalog-cards';
import { MarketOrderedRow } from './market-ordered-reader';

const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const fileId = '00000000-0000-0000-0000-000000000003';
const logoId = '00000000-0000-0000-0000-000000000004';
const instant = new Date('2026-11-21T12:00:00.000Z');
type Product = CapturedMarketCard['product'];
type CaptureTx = Parameters<typeof captureMarketCatalogCards>[0];
type Uploads = Parameters<typeof hydrateMarketCatalogCards>[1];

function product(id = first, overrides: Partial<Product> = {}): Product {
  return {
    id,
    name: 'Public piece',
    description: 'Description',
    slug: 'public-piece',
    isActive: true,
    publicationStatus: 'PUBLISHED',
    deletedAt: null,
    archivedAt: null,
    publishAt: null,
    price: new Prisma.Decimal(10000),
    salePrice: null,
    saleStartAt: null,
    saleEndAt: null,
    currency: 'NGN',
    thumbnail: 'https://private-store.example/original',
    images: [],
    totalStock: 5,
    customOrderEnabled: false,
    standardCheckoutEnabled: true,
    collections: [],
    brandId: second,
    firstPublishedAt: new Date(instant),
    viewsCount: 12,
    threadsCount: 3,
    createdAt: new Date(instant),
    updatedAt: new Date(instant),
    brand: {
      id: second,
      name: 'Public brand',
      logo: null,
      createdAt: new Date(instant),
      isStoreOpen: true,
      owner: { id: second, status: 'ACTIVE' },
    },
    category: {
      id: second,
      slug: 'category',
      name: 'Category',
      isActive: true,
    },
    media: [
      {
        file: {
          id: fileId,
          s3Url: 'https://private-store.example/original',
          width: 1200,
          height: 1600,
          assetVersion: 2,
        },
      },
    ],
    ...overrides,
  };
}
function fixture(
  products: Product[],
  tags: Array<{ entityId: string; normalizedName: string }> = [],
  variants: Array<{ fileUploadId: string; s3Url: string }> = [],
) {
  const findProducts = jest.fn().mockResolvedValue(products),
    findFiles = jest.fn().mockResolvedValue([]);
  const query = jest
    .fn()
    .mockResolvedValueOnce(tags)
    .mockResolvedValueOnce(variants);
  const tx = {
    product: { findMany: findProducts },
    fileUpload: { findMany: findFiles },
    $queryRaw: query,
  } as unknown as CaptureTx;
  return { tx, findProducts, findFiles, query };
}
function uploads(
  originals = new Map<string, string>(),
  variants = new Map<string, string>(),
) {
  const publicUrls = jest.fn().mockResolvedValue(originals),
    variantUrls = jest.fn().mockResolvedValue(variants);
  return {
    publicUrls,
    variantUrls,
    service: {
      getBatchPublicSignedUrls: publicUrls,
      getBatchVariantDisplayUrls: variantUrls,
    } as unknown as Uploads,
  };
}
const capture = (
  tx: CaptureTx,
  rows: MarketOrderedRow[] = [{ id: first }],
  asOf = new Date(instant),
) => captureMarketCatalogCards(tx, { rows, asOf });

describe('catalogue card capture inside the ordered transaction', () => {
  it('reads only bounded ordered IDs through canonical publication/store/owner gates', async () => {
    const { tx, findProducts } = fixture([product()]);
    await capture(tx);
    expect(findProducts).toHaveBeenCalledTimes(1);
    const input = findProducts.mock.calls[0][0];
    expect(input).toMatchObject({
      take: 61,
      where: {
        isActive: true,
        publicationStatus: 'PUBLISHED',
        deletedAt: null,
        archivedAt: null,
        brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
      },
    });
    expect(input.where.AND).toEqual(
      expect.arrayContaining([{ id: { in: [first] } }, { currency: 'NGN' }]),
    );
    expect(input.select.media).toMatchObject({
      take: Object.values(ContentMediaViewSlot).length,
      where: {
        reviewStatus: 'APPROVED',
        file: {
          processingStatus: 'READY',
          originalDeletedAt: null,
          mimeType: {
            in: expect.arrayContaining(['image/jpeg', 'image/webp']),
          },
        },
      },
    });
    expect(input.select.collections.take).toBe(1);
    expect(input.select.media.select.file.select).not.toHaveProperty(
      'variants',
    );
  });
  it('keeps server ordering even when the database hydration batch returns a different order', async () => {
    const { tx } = fixture([product(second), product(first)]);
    const cards = await capture(tx, [{ id: first }, { id: second }]);
    expect(cards.map((card) => card.product.id)).toEqual([first, second]);
  });
  it('does no reads for an empty page and drops missing/deleted products honestly', async () => {
    const empty = fixture([]);
    await expect(capture(empty.tx, [])).resolves.toEqual([]);
    expect(empty.findProducts).not.toHaveBeenCalled();
    expect(empty.query).not.toHaveBeenCalled();
    const missing = fixture([]);
    await expect(capture(missing.tx)).resolves.toEqual([]);
    expect(missing.query).not.toHaveBeenCalled();
  });
  it.each([
    ['draft', { publicationStatus: 'DRAFT' }],
    ['deleted', { deletedAt: new Date(instant) }],
    ['archived', { archivedAt: new Date(instant) }],
    ['future publication', { publishAt: new Date(instant.getTime() + 1) }],
    ['depleted stock', { totalStock: 0, customOrderEnabled: false }],
    ['missing usable media', { thumbnail: ' ', images: [] }],
    [
      'unanchored cover',
      { thumbnail: 'https://private-store.example/unrelated' },
    ],
    ['no approved media', { media: [] }],
  ])(
    'does not render %s even if hydration data is stale or incomplete',
    async (_label, overrides) => {
      const { tx } = fixture([product(first, overrides as Partial<Product>)]);
      await expect(capture(tx)).resolves.toEqual([]);
    },
  );
  it('rechecks closed stores and suspended owners before returning captured cards', async () => {
    const closed = product(),
      suspended = product(second);
    closed.brand.isStoreOpen = false;
    suspended.brand.owner.status = 'SUSPENDED';
    await expect(
      capture(fixture([closed, suspended]).tx, [{ id: first }, { id: second }]),
    ).resolves.toEqual([]);
  });
  it('requires an approved anchored file for a variant cover from the current asset version', async () => {
    const cover = 'https://private-store.example/current-card.webp';
    const { tx, query } = fixture(
      [product(first, { thumbnail: cover })],
      [],
      [{ fileUploadId: fileId, s3Url: cover }],
    );
    const cards = await capture(tx);
    expect(cards[0]?.file.id).toBe(fileId);
    const sql = query.mock.calls[1][0] as Prisma.Sql;
    expect(sql.text).toContain('file."assetVersion"=variant."assetVersion"');
    expect(sql.values).toEqual(expect.arrayContaining([fileId, cover]));
    const stale = fixture([product(first, { thumbnail: cover })]);
    await expect(capture(stale.tx)).resolves.toEqual([]);
    const unrelated = fixture(
      [product(first, { thumbnail: cover })],
      [],
      [{ fileUploadId: logoId, s3Url: cover }],
    );
    await expect(capture(unrelated.tx)).resolves.toEqual([]);
  });
  it('loads only approved canonical tags in a per-product bounded batch', async () => {
    const tags = Array.from({ length: 30 }, (_, index) => ({
      entityId: first,
      normalizedName: `tag-${index}`,
    }));
    const { tx, query } = fixture([product()], tags);
    const [card] = await capture(tx);
    expect(card.tags).toHaveLength(25);
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain("tag.status='APPROVED'");
    expect(sql.text).toContain('NOT tag."isBanned"');
    expect(sql.text).toContain('tag."aliasOfTagId" IS NULL');
    expect(sql.text).toContain('PARTITION BY binding."entityId"');
    expect(sql.text).toContain('position<=25');
    expect(sql.values).toContain(first);
  });
  it('binds a logo to the same public brand owner and profile-image relation', async () => {
    const item = product();
    item.brand.logo = ' https://private-store.example/logo ';
    const { tx, findFiles } = fixture([item]);
    findFiles.mockResolvedValue([
      {
        id: logoId,
        s3Url: 'https://private-store.example/logo',
        userId: second,
      },
    ]);
    expect((await capture(tx))[0].logoFileId).toBe(logoId);
    expect(findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 61,
        where: expect.objectContaining({
          fileType: 'PROFILE_IMAGE',
          processingStatus: 'READY',
          originalDeletedAt: null,
          OR: [
            {
              s3Url: 'https://private-store.example/logo',
              userId: second,
              userProfileImages: { some: { userId: second } },
            },
          ],
        }),
      }),
    );
    findFiles.mockResolvedValue([
      {
        id: logoId,
        s3Url: 'https://private-store.example/logo',
        userId: first,
      },
    ]);
    const fresh = fixture([item]);
    fresh.findFiles.mockImplementation(findFiles);
    expect((await capture(fresh.tx))[0].logoFileId).toBeNull();
  });
  it('uses the captured inclusive sale window and rejects a price/order mismatch', async () => {
    const sale = product(first, {
      salePrice: new Prisma.Decimal(5000),
      saleStartAt: new Date(instant),
      saleEndAt: new Date(instant),
    });
    const { tx } = fixture([sale]);
    await expect(
      capture(tx, [{ id: first, amount: new Prisma.Decimal(10000) }]),
    ).rejects.toMatchObject({
      response: { code: 'CATALOGUE_PRICE_CONTEXT_CHANGED' },
    });
    const matching = fixture([sale]);
    const cards = await capture(matching.tx, [
      { id: first, amount: new Prisma.Decimal(5000) },
    ]);
    const urls = uploads(new Map([[fileId, 'https://public.example/signed']]));
    expect(
      (await hydrateMarketCatalogCards(cards, urls.service))[0].price,
    ).toMatchObject({
      amount: 10000,
      effectiveAmount: 5000,
      saleAmount: 5000,
    });
  });
  it('does not let later caller Date mutation change the captured sale decision', async () => {
    const asOf = new Date(instant);
    const sale = product(first, {
      salePrice: new Prisma.Decimal(5000),
      saleEndAt: new Date(instant),
    });
    const cards = await capture(
      fixture([sale]).tx,
      [{ id: first, amount: new Prisma.Decimal(5000) }],
      asOf,
    );
    asOf.setTime(instant.getTime() + 1);
    const urls = uploads(new Map([[fileId, 'https://public.example/signed']]));
    expect(
      (await hydrateMarketCatalogCards(cards, urls.service))[0].price
        ?.effectiveAmount,
    ).toBe(5000);
    expect(cards[0].asOf.getTime()).toBe(instant.getTime());
  });
  it('rejects over-budget input and invalid clocks before acquiring data', async () => {
    const { tx, findProducts } = fixture([]);
    await expect(
      capture(
        tx,
        Array.from({ length: 62 }, () => ({ id: first })),
      ),
    ).rejects.toThrow(RangeError);
    await expect(capture(tx, [], new Date(NaN))).rejects.toThrow(RangeError);
    expect(findProducts).not.toHaveBeenCalled();
  });
});

describe('catalogue public card signing after capture', () => {
  const captured = (item = product()): CapturedMarketCard => ({
    product: item,
    file: item.media[0].file,
    logoFileId: null,
    tags: ['approved-tag'],
    asOf: new Date(instant),
  });
  it('publicly authorizes originals before sending only vouched IDs for variant signing', async () => {
    const urls = uploads(
      new Map([[fileId, 'https://public.example/original']]),
      new Map([[fileId, 'https://public.example/card']]),
    );
    const card = { ...captured(), logoFileId: logoId };
    const items = await hydrateMarketCatalogCards([card], urls.service);
    expect(urls.publicUrls).toHaveBeenCalledWith([fileId, logoId]);
    expect(urls.variantUrls).toHaveBeenCalledWith([fileId], 'CARD');
    expect(urls.publicUrls.mock.invocationCallOrder[0]).toBeLessThan(
      urls.variantUrls.mock.invocationCallOrder[0],
    );
    expect(items[0].media?.url).toBe('https://public.example/card');
    expect(items[0].brand?.logoUrl).toBeNull();
  });
  it('never falls back to a private stored URL when public authorization denies the file', async () => {
    const urls = uploads();
    await expect(
      hydrateMarketCatalogCards([captured()], urls.service),
    ).resolves.toEqual([]);
    expect(urls.variantUrls).toHaveBeenCalledWith([], 'CARD');
  });
  it('uses an authorized original if a processed variant is absent', async () => {
    const urls = uploads(
      new Map([[fileId, 'https://public.example/original']]),
    );
    const items = await hydrateMarketCatalogCards([captured()], urls.service);
    expect(items[0].media).toMatchObject({
      url: 'https://public.example/original',
      fileId,
      width: 1200,
      height: 1600,
      aspectRatio: 0.75,
    });
    expect(JSON.stringify(items)).not.toContain('private-store.example');
  });
  it('omits inactive taxonomy, retains approved tags and safely encodes product slugs', async () => {
    const item = product(first, { slug: 'silk / wrap' });
    item.category!.isActive = false;
    const urls = uploads(
      new Map([[fileId, 'https://public.example/original']]),
    );
    const [card] = await hydrateMarketCatalogCards(
      [captured(item)],
      urls.service,
    );
    expect(card.category).toBeNull();
    expect(card.tags).toEqual(['approved-tag']);
    expect(card.target.route).toBe('/market-place/products/silk%20%2F%20wrap');
  });
  it('provides a safe ID route and no false dimensions when metadata is missing', async () => {
    const item = product(first, { slug: null });
    item.media[0].file.width = 0;
    item.media[0].file.height = null;
    const urls = uploads(
      new Map([[fileId, 'https://public.example/original']]),
    );
    const [card] = await hydrateMarketCatalogCards(
      [captured(item)],
      urls.service,
    );
    expect(card.target.route).toBe(`/market-place?productId=${first}`);
    expect(card.media).toMatchObject({
      width: null,
      height: null,
      aspectRatio: null,
    });
  });
  it('deduplicates signing IDs, retains card order and resolves a public logo only from its authorized map', async () => {
    const urls = uploads(
      new Map([
        [fileId, 'https://public.example/original'],
        [logoId, 'https://public.example/logo'],
      ]),
    );
    const cards = [
      { ...captured(product(second)), logoFileId: logoId },
      { ...captured(product(first)), logoFileId: logoId },
    ];
    const items = await hydrateMarketCatalogCards(cards, urls.service);
    expect(urls.publicUrls).toHaveBeenCalledWith([fileId, logoId]);
    expect(items.map((item) => item.id)).toEqual([second, first]);
    expect(items[0].brand?.logoUrl).toBe('https://public.example/logo');
  });
  it('makes no signing calls for empty input and rejects excess card counts', async () => {
    const urls = uploads();
    await expect(hydrateMarketCatalogCards([], urls.service)).resolves.toEqual(
      [],
    );
    await expect(
      hydrateMarketCatalogCards(
        Array.from({ length: 62 }, () => captured()),
        urls.service,
      ),
    ).rejects.toThrow(RangeError);
    expect(urls.publicUrls).not.toHaveBeenCalled();
  });
  it('propagates public authorization failure and never proceeds to variant signing', async () => {
    const urls = uploads(),
      failure = new Error('Authorization unavailable');
    urls.publicUrls.mockRejectedValue(failure);
    await expect(
      hydrateMarketCatalogCards([captured()], urls.service),
    ).rejects.toBe(failure);
    expect(urls.variantUrls).not.toHaveBeenCalled();
  });
});
