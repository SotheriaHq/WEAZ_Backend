import { Prisma } from '@prisma/client';
import {
  eligibleProductSql,
  eligibleProductWhere,
  isEligibleProduct,
  isPublicStoreCollectionMembership,
  usableProductImage,
} from './market-eligibility';

const now = new Date('2026-11-14T12:00:00.000Z');
const valid = () => ({
  isActive: true,
  publicationStatus: 'PUBLISHED',
  deletedAt: null,
  archivedAt: null,
  publishAt: null,
  price: new Prisma.Decimal(10000),
  thumbnail: null,
  images: ['https://media.example/card.webp'],
  totalStock: 2,
  customOrderEnabled: false,
  brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
  collections: [],
});

describe('canonical product eligibility', () => {
  it.each(['PUBLIC', 'PRIVATE', undefined])(
    'keeps D03 product eligibility independent from collection visibility %s',
    (visibility) => {
      const collection = {
        status: 'PUBLISHED',
        visibility,
        isAvailableInStore: true,
        deletedAt: null,
      };
      expect(
        isEligibleProduct({ ...valid(), collections: [{ collection }] }, now),
      ).toBe(true);
      expect(isPublicStoreCollectionMembership(collection)).toBe(
        visibility === 'PUBLIC',
      );
    },
  );

  it('finds a usable image after blank thumbnails or earlier blank array entries', () => {
    expect(
      usableProductImage({
        thumbnail: '  ',
        images: ['', '  ', ' https://media.example/card.webp '],
      }),
    ).toBe('https://media.example/card.webp');
    expect(usableProductImage({ thumbnail: '', images: ['', ' '] })).toBeNull();
    expect(usableProductImage(undefined)).toBeNull();
  });

  it('retains standalone, stock-backed and custom-order products', () => {
    expect(isEligibleProduct(valid(), now)).toBe(true);
    expect(
      isEligibleProduct(
        { ...valid(), totalStock: 0, customOrderEnabled: true },
        now,
      ),
    ).toBe(true);
    expect(isEligibleProduct({ ...valid(), publishAt: now }, now)).toBe(true);
  });

  it.each([
    'DRAFT',
    'IN_REVIEW',
    'CHANGES_REQUESTED',
    'REJECTED',
    'ARCHIVED',
    undefined,
  ])(
    'rejects publication state %s, including omitted fields',
    (publicationStatus) => {
      expect(isEligibleProduct({ ...valid(), publicationStatus }, now)).toBe(
        false,
      );
    },
  );

  it.each([
    { isActive: false },
    { deletedAt: now },
    { archivedAt: now },
    { publishAt: new Date(now.getTime() + 1) },
    { brand: { isStoreOpen: false, owner: { status: 'ACTIVE' } } },
    { brand: { isStoreOpen: true, owner: { status: 'SUSPENDED' } } },
    { brand: { isStoreOpen: true } },
    { totalStock: 0, allowBackorders: true, trackInventory: false },
    { images: [], thumbnail: null },
    { price: 0 },
    { price: -1 },
    { collections: undefined },
    {
      collections: [
        {
          collection: {
            status: 'DRAFT',
            isAvailableInStore: true,
            deletedAt: null,
          },
        },
      ],
    },
    {
      collections: [
        {
          collection: {
            status: 'PUBLISHED',
            isAvailableInStore: false,
            deletedAt: null,
          },
        },
      ],
    },
    {
      collections: [
        {
          collection: {
            status: 'PUBLISHED',
            isAvailableInStore: true,
            deletedAt: now,
          },
        },
      ],
    },
  ])(
    'fails closed for an ineligible or incompletely hydrated row: %j',
    (patch) => {
      expect(isEligibleProduct({ ...valid(), ...patch }, now)).toBe(false);
    },
  );

  it('accepts one available published collection among unavailable links', () => {
    expect(
      isEligibleProduct(
        {
          ...valid(),
          collections: [
            {
              collection: {
                status: 'DRAFT',
                isAvailableInStore: true,
                deletedAt: null,
              },
            },
            {
              collection: {
                status: 'PUBLISHED',
                isAvailableInStore: true,
                deletedAt: null,
              },
            },
          ],
        },
        now,
      ),
    ).toBe(true);
  });

  it('does not require the not-yet-created effectivePrice column', () => {
    for (const salePrice of [null, 0, -1, 5000, 20000]) {
      const product = { ...valid(), salePrice };
      expect(isEligibleProduct(product, now)).toBe(true);
    }
    expect(JSON.stringify(eligibleProductWhere(now))).not.toContain(
      'effectivePrice',
    );
    expect(eligibleProductSql(now).text).not.toContain('effectivePrice');
  });

  it('uses a closed identifier registry and parameterized date values', () => {
    const sql = eligibleProductSql(now);
    expect(sql.text).toContain('p."isActive"');
    expect(sql.values).toContainEqual(now);
    expect(sql.values).not.toContain('p');
    expect(() =>
      eligibleProductSql(now, 'p; DROP TABLE "Product"' as 'p'),
    ).toThrow();
  });
});
