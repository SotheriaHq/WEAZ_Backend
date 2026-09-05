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
const transform = (product: any, options?: { includeOwnerFinancials?: boolean }) =>
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
});
