import { Prisma } from '@prisma/client';
import { createMarketCatalogScope } from './market-catalog-scope';
import {
  createMarketPlanNames,
  isUnfilteredMarketRead,
  marketPlan,
  marketPlanIf,
} from './market-read-plans';

const id = '00000000-0000-0000-0000-000000000001';
const marked = (label: string, text = 'SELECT 1') =>
  marketPlan(label, Prisma.sql([text])).text;

describe('reusable Market plans', () => {
  it('marks a statement without changing its parameters', () => {
    const sql = marketPlan('cards', Prisma.sql`SELECT ${id}::uuid`);
    expect(sql.text).toBe('/*market-plan:cards*/ SELECT $1::uuid');
    expect(sql.values).toEqual([id]);
    expect(
      marketPlanIf(false, 'cards', Prisma.sql`SELECT ${id}::uuid`).text,
    ).toBe('SELECT $1::uuid');
  });
  it.each(['', 'Cards', 'a b', '*/ DROP', 'x'.repeat(41)])(
    'rejects the unsafe label %p',
    (label) => {
      expect(() => marketPlan(label, Prisma.sql`SELECT 1`)).toThrow(RangeError);
    },
  );
  it('names only marked statements, by their exact text', () => {
    const name = createMarketPlanNames();
    expect(name({ sql: 'SELECT 1' })).toBe('');
    expect(name({ sql: 'BEGIN' })).toBe('');
    const first = name({ sql: marked('cards') });
    expect(first).toMatch(/^market_[0-9a-f]{32}$/);
    expect(name({ sql: marked('cards') })).toBe(first);
    expect(name({ sql: marked('cards', 'SELECT 2') })).not.toBe(first);
    expect(name({ sql: ` ${marked('cards')}` })).toBe('');
  });
  it('keeps a closed number of shapes and leaves the rest unnamed', () => {
    const name = createMarketPlanNames(2);
    const kept = name({ sql: marked('a') });
    expect(name({ sql: marked('b') })).not.toBe('');
    expect(name({ sql: marked('c') })).toBe('');
    expect(name({ sql: marked('a') })).toBe(kept);
  });
  it('reuses plans only for default browse shapes', () => {
    const scope = createMarketCatalogScope({
      key: 'catalog',
      version: '1',
      viewer: { userId: id },
    });
    expect(isUnfilteredMarketRead({})).toBe(true);
    expect(isUnfilteredMarketRead({}, {}, scope)).toBe(true);
    expect(isUnfilteredMarketRead({ colors: ['red'] })).toBe(false);
    expect(isUnfilteredMarketRead({}, { colors: ['red'] })).toBe(false);
    expect(
      isUnfilteredMarketRead(
        {},
        {},
        createMarketCatalogScope({ ...scope, productIds: [id] }),
      ),
    ).toBe(false);
    expect(
      isUnfilteredMarketRead(
        {},
        {},
        createMarketCatalogScope({ ...scope, lowStockMax: 2 }),
      ),
    ).toBe(false);
  });
});
