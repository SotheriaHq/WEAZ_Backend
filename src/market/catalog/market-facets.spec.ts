import { Prisma } from '@prisma/client';
import { readMarketFacets } from './market-facets';
import { marketFacetQueries } from './market-facets.sql';
import { createMarketCatalogScope } from './market-catalog-scope';

const now = new Date('2026-11-21T12:00:00.000Z');
const option = (key: string, value: string, count: string, extra = {}) => ({
  key,
  value,
  label: value,
  count,
  selected: false,
  categoryId: null,
  name: null,
  isMulti: null,
  available: '1',
  limit: 12,
  ...extra,
});
function reader(groups: unknown[][]) {
  const query = jest.fn().mockResolvedValue(
    Array.from({ length: 8 }, (_, group) => ({
      group,
      rows: groups[group] ?? [],
    })),
  );
  return {
    query,
    tx: { $queryRaw: query } as unknown as Pick<
      Prisma.TransactionClient,
      '$queryRaw'
    >,
  };
}

describe('transaction-local market facets', () => {
  it('returns no invented keys or price bands for an empty catalogue in one batched read', async () => {
    const { tx, query } = reader([
      [],
      [],
      [],
      [],
      [],
      [],
      [
        {
          count: '0',
          min: null,
          max: null,
          percentiles: null,
          bandMin: null,
          bandMax: null,
          bandCount: '0',
        },
      ],
      [],
    ]);
    await expect(readMarketFacets(tx, { filters: {}, now })).resolves.toEqual(
      {},
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('retains selected disabled approved values, omits whole-zero keys and exposes truncation', async () => {
    const { tx } = reader([
      [
        option('category', 'a', '2'),
        option('category', 'b', '0', { selected: true, available: '2' }),
      ],
      [option('brand', 'a', '4', { available: '13' })],
      [],
      [],
      [option('color', 'red', '0', { selected: true })],
      [],
      [],
      [],
    ]);
    const result = await readMarketFacets(tx, { filters: {}, now });
    expect(result.categories?.[1]).toMatchObject({
      value: 'b',
      count: 0,
      disabled: true,
    });
    expect(result.colors).toBeUndefined();
    expect(result.truncation?.brand).toEqual({
      limit: 12,
      returned: 1,
      available: 13,
    });
  });
  it('reports custom fit independently from the finite size vocabulary', async () => {
    const { tx } = reader([
      [],
      [],
      [],
      [],
      [],
      [option('sizeCustomFit', 'ANY', '3')],
      [],
      [],
    ]);
    await expect(readMarketFacets(tx, { filters: {}, now })).resolves.toEqual({
      sizeSupport: { customFitAnySize: true, customFitCount: 3 },
    });
  });
  it('keeps dimension labels/multiplicity and safe prototype-like public slugs', async () => {
    const { tx } = reader([
      [],
      [],
      [],
      [
        option('dim.constructor', 'classic', '2', {
          name: 'Heritage',
          isMulti: false,
          keysAvailable: '40',
        }),
      ],
      [],
      [],
      [],
      [],
    ]);
    const result = await readMarketFacets(tx, { filters: {}, now });
    expect(result.dimensions?.constructor).toEqual({
      name: 'Heritage',
      isMulti: false,
      values: [
        { value: 'classic', label: 'classic', count: 2, disabled: false },
      ],
    });
    expect(result.truncation?.dimensions).toEqual({
      limit: 32,
      returned: 1,
      available: 40,
    });
  });
  it('serializes actual price statistics and inclusive bands without empty bands', async () => {
    const shared = {
      count: '2',
      min: '10000.00',
      max: '30000.00',
      percentiles: [16000, 22000, 27000],
    };
    const { tx } = reader([
      [],
      [],
      [],
      [],
      [],
      [],
      [
        { ...shared, bandMin: '10000', bandMax: '15000', bandCount: '1' },
        { ...shared, bandMin: '15000.01', bandMax: '20000', bandCount: '0' },
        { ...shared, bandMin: '20000.01', bandMax: '30000', bandCount: '1' },
      ],
      [],
    ]);
    const result = await readMarketFacets(tx, { filters: {}, now });
    expect(result.price).toEqual({
      currency: 'NGN',
      min: 10000,
      max: 30000,
      count: 2,
      percentiles: { p30: 16000, p60: 22000, p85: 27000 },
      bands: [
        { min: 10000, max: 15000, count: 1 },
        { min: 20000.01, max: 30000, count: 1 },
      ],
    });
  });
  it.each(['-1', 'NaN', '9007199254740992'])(
    'rejects invalid/unsafe count %s',
    async (value) => {
      const { tx } = reader([[option('category', 'a', value)]]);
      await expect(readMarketFacets(tx, { filters: {}, now })).rejects.toThrow(
        RangeError,
      );
    },
  );
  it('propagates database failures', async () => {
    const error = new Error('Unavailable');
    const tx = {
      $queryRaw: jest.fn().mockRejectedValue(error),
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
    await expect(readMarketFacets(tx, { filters: {}, now })).rejects.toBe(
      error,
    );
  });
  it('binds hostile selections and preserves the same trusted scope in each count group', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const scope = createMarketCatalogScope({
      key: 'fixed',
      version: '1',
      viewer: {},
      productIds: [id],
    });
    const queries = marketFacetQueries({
      filters: {
        colors: ["red'); SELECT 1; --"],
        dimensions: { style: ['classic'] },
      },
      fixedFilters: { sizes: ['M'] },
      scope,
      now,
    });
    expect(queries).toHaveLength(8);
    for (const query of queries) {
      expect(query.text).not.toContain("red'); SELECT 1; --");
      expect(query.values).toContain(id);
    }
    expect(queries[3].text).toContain('d.slug =');
    expect(queries[5].text).toContain('custom.count');
  });
});
