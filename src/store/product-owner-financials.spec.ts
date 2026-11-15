import { StoreService } from './store.service';

/**
 * What a product COST the brand is the brand's business, and nobody else's.
 *
 * `transformProduct` is the single serializer behind `GET /products/:id`,
 * `GET /products/market` and `GET /brands/:brandId/products`. All three answer
 * an unauthenticated request, and all three were emitting `costPerItem` and
 * `profitMargin` — so any shopper browsing the market, or a competitor with
 * curl, could read every brand's unit cost and margin straight out of the
 * public feed.
 *
 * The fields are now absent unless the caller has established brand ownership.
 * Absent, not null: "you may not see this" must not be confusable with "the
 * brand has not set a cost".
 */
const transform = (
  product: any,
  options?: { includeOwnerFinancials?: boolean },
) =>
  (Object.create(StoreService.prototype) as any).transformProduct(
    product,
    options,
  );

const product = {
  id: 'product-1',
  brandId: 'brand-1',
  name: 'Linen shirt',
  slug: 'linen-shirt',
  price: '50000',
  salePrice: null,
  currency: 'NGN',
  costPerItem: '18000',
  sizes: [],
  variants: [],
  collections: [],
};

describe('product owner financials', () => {
  it.each([
    ['0', 100, false],
    ['100', 100, false],
    ['110', 100, false],
    ['90', 90, true],
  ])(
    'renders catalogue price consistently for sale %s',
    (salePrice, effectivePrice, isOnSale) => {
      const view = transform({ ...product, price: '100', salePrice });
      expect(view.effectivePrice).toBe(effectivePrice);
      expect(view.isOnSale).toBe(isOnSale);
    },
  );

  it('omits cost and margin by default', () => {
    const view = transform(product);
    expect('costPerItem' in view).toBe(false);
    expect('profitMargin' in view).toBe(false);
    // The public price is untouched — this is about cost, not about pricing.
    expect(view.price).toBe(50000);
  });

  it('omits cost and margin for a non-owner explicitly', () => {
    const view = transform(product, { includeOwnerFinancials: false });
    expect('costPerItem' in view).toBe(false);
    expect('profitMargin' in view).toBe(false);
  });

  it('gives the owner the cost and the margin derived from it', () => {
    const view = transform(product, { includeOwnerFinancials: true });
    expect(view.costPerItem).toBe(18000);
    // (50000 - 18000) / 50000 = 64%
    expect(view.profitMargin).toBe(64);
  });

  it('does not leak the cost through any other key', () => {
    const view = transform(product);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('18000');
  });

  it('never exposes the owner authority relation or private collection metadata publicly', () => {
    const draft = {
      id: 'private',
      title: 'Unreleased capsule',
      status: 'DRAFT',
      visibility: 'PRIVATE',
      isAvailableInStore: true,
      deletedAt: null,
    };
    const published = {
      id: 'public',
      title: 'Public capsule',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      isAvailableInStore: true,
      deletedAt: null,
    };
    const source = {
      ...product,
      brand: { id: 'brand', name: 'Brand', owner: { status: 'ACTIVE' } },
      collection: draft,
      collections: [
        { collectionId: draft.id, orderIndex: 0, collection: draft },
        { collectionId: published.id, orderIndex: 1, collection: published },
      ],
    };
    const view = transform(source);
    expect(view.brand).toEqual({ id: 'brand', name: 'Brand' });
    expect(view.collectionIds).toEqual(['public']);
    expect(view.collection.title).toBe('Public capsule');
    expect(JSON.stringify(view)).not.toContain('Unreleased capsule');
    const owner = transform(source, { includeOwnerFinancials: true });
    expect(owner.collectionIds).toEqual(['private', 'public']);
    expect(owner.collection.title).toBe('Unreleased capsule');
    const minimal = transform({
      ...source,
      collections: [
        {
          collectionId: 'public',
          collection: {
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            isAvailableInStore: true,
            deletedAt: null,
          },
        },
      ],
    });
    expect(minimal.collection).toBeNull();
    expect(minimal.collectionIds).toEqual(['public']);
  });

  it.each(['PRIVATE', undefined])(
    'hides published collection metadata when visibility is %s, preserving owner preview',
    (visibility) => {
      const collection = {
        id: 'hidden-capsule-id',
        title: 'Confidential capsule',
        description: 'Unannounced launch details',
        status: 'PUBLISHED',
        visibility,
        isAvailableInStore: true,
        deletedAt: null,
      };
      const source = {
        ...product,
        collectionId: collection.id,
        collection,
        collections: [{ collectionId: collection.id, collection }],
      };
      const view = transform(source);
      expect(view.collectionId).toBeNull();
      expect(view.collectionIds).toEqual([]);
      expect(view.collection).toBeNull();
      for (const value of [
        collection.id,
        collection.title,
        collection.description,
      ])
        expect(JSON.stringify(view)).not.toContain(value);
      const owner = transform(source, { includeOwnerFinancials: true });
      expect(owner.collectionIds).toEqual([collection.id]);
      expect(owner.collection).toEqual(collection);
    },
  );
});
