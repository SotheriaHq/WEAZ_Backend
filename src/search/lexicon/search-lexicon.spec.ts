import {
  buildSearchLexiconBlob,
  parseSearchLexiconBlob,
  SearchLexiconCapacityError,
} from './search-lexicon-blob';
import { lexiconSimilarity, SearchLexiconIndex } from './search-lexicon.index';
import { parseSearchQuery } from './search-lexicon.parser';
import {
  boundedEditDistance,
  formKey,
  singularize,
} from './search-lexicon.text';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (
  kind: string,
  value: string | null,
  label: string | null,
  extra: Record<string, unknown> = {},
) => ({
  kind,
  value,
  label,
  names: null,
  count: 5,
  dimension: null,
  categoryId: null,
  p30: null,
  p80: null,
  ...extra,
});
const ROWS = [
  row('price', null, null, { count: 100, p30: '20000', p80: '90000' }),
  row('synonym', 'gown', 'dress'),
  row('category', id(1), 'Dresses & Gowns'),
  row('category', id(2), 'Agbada'),
  row('type', id(11), 'Evening gown', {
    categoryId: id(1),
    names: ['evening dress'],
  }),
  row('type', id(12), 'Iro and Buba', { categoryId: id(2) }),
  row('dimension', 'linen', 'Linen', { dimension: 'fabric' }),
  row('brand', id(21), 'Zuri Threads'),
  row('color', 'black', 'Black'),
  row('color', 'red', 'Red'),
  row('color', 'royal blue', 'Royal Blue'),
  row('size', '42', '42'),
  row('size', 'M', 'M'),
  row('word', 'shirt', 'shirt'),
] as any[];
const at = new Date('2026-11-26T10:00:00.000Z');
const blob = () =>
  buildSearchLexiconBlob(ROWS, {
    sourceAsOf: at,
    builtAt: at,
    maxRows: 10_000,
  });
const index = new SearchLexiconIndex(blob());
const parse = (query: string, options = {}) =>
  parseSearchQuery(query, index, options);
const labels = (query: string, options = {}) =>
  parse(query, options).attributes.map(
    (item) => `${item.type}:${item.value}:${item.applied}`,
  );

describe('search lexicon text', () => {
  it('folds plurals and possessives into one match key', () => {
    expect(singularize('dresses')).toBe('dress');
    expect(singularize('kaftans')).toBe('kaftan');
    expect(singularize('dress')).toBe('dress');
    expect(singularize('bus')).toBe('bus');
    expect(formKey("Men's Iro and Buba")).toBe(formKey('men iro buba'));
  });

  it('bounds edit distance and reports one edit for a transposition', () => {
    expect(boundedEditDistance('kaftan', 'kafatn', 1)).toBe(1);
    expect(boundedEditDistance('agbada', 'agbda', 1)).toBe(1);
    expect(boundedEditDistance('agbada', 'xyz', 1)).toBe(2);
    expect(lexiconSimilarity('agbda', 'agbada')).toBeGreaterThanOrEqual(0.8);
    // Short words are never fuzzy-matched by edit distance.
    expect(lexiconSimilarity('red', 'rod')).toBeLessThan(0.5);
  });
});

describe('search lexicon blob', () => {
  it('round-trips and changes version only when served input changes', () => {
    const first = blob();
    expect(parseSearchLexiconBlob(JSON.stringify(first))).toEqual(first);
    const rebuilt = buildSearchLexiconBlob(ROWS, {
      sourceAsOf: new Date('2026-11-26T11:00:00.000Z'),
      builtAt: new Date('2026-11-26T11:00:00.000Z'),
      maxRows: 10_000,
    });
    expect(rebuilt.version).toBe(first.version);
    const changed = buildSearchLexiconBlob(
      [...ROWS, row('color', 'pink', 'Pink')],
      { sourceAsOf: at, builtAt: at, maxRows: 10_000 },
    );
    expect(changed.version).not.toBe(first.version);
  });

  it('rejects a tampered, partial or oversized stored lexicon whole', () => {
    const good = blob();
    const tamper = (patch: Record<string, unknown>) =>
      parseSearchLexiconBlob(JSON.stringify({ ...good, ...patch }));
    expect(parseSearchLexiconBlob('{')).toBeNull();
    expect(parseSearchLexiconBlob(null)).toBeNull();
    expect(tamper({ schema: 'search.lexicon.v0' })).toBeNull();
    expect(tamper({ version: 'not-a-version' })).toBeNull();
    expect(
      tamper({ entries: [{ ...good.entries[0], kind: 'script' }] }),
    ).toBeNull();
    expect(tamper({ entries: [{ ...good.entries[0], count: 0 }] })).toBeNull();
    expect(tamper({ price: { p30: 90, p80: 20, count: 1 } })).toBeNull();
    expect(tamper({ words: ['two words'] })).toBeNull();
    expect(parseSearchLexiconBlob('x'.repeat(4 * 1024 * 1024 + 1))).toBeNull();
  });

  it('refuses mandatory vocabulary beyond the row ceiling, never truncating it', () => {
    expect(() =>
      buildSearchLexiconBlob(ROWS, { sourceAsOf: at, builtAt: at, maxRows: 3 }),
    ).toThrow(SearchLexiconCapacityError);
  });

  it('drops source rows with invalid identifiers or zero counts', () => {
    const built = buildSearchLexiconBlob(
      [
        row('category', 'not-a-uuid', 'Bad'),
        row('brand', id(30), 'Empty', { count: 0 }),
        row('dimension', 'BAD SLUG', 'Bad', { dimension: 'fabric' }),
        row('color', 'teal', 'Teal'),
      ] as any[],
      { sourceAsOf: at, builtAt: at, maxRows: 10_000 },
    );
    expect(built.entries.map((entry) => entry.value)).toEqual(['teal']);
  });
});

describe('search query parser', () => {
  it('turns whole phrases into hard filters and leaves the rest as text', () => {
    expect(labels('black evening dress')).toEqual([
      `garmentType:${id(11)}:filter`,
      'color:black:filter',
    ]);
    expect(parse('black evening dress').residual).toBe('');
    expect(parse('red sneakers size 42').residual).toBe('sneakers');
    expect(parse('red sneakers size 42').filters).toMatchObject({
      colors: ['red'],
      sizes: ['42'],
    });
  });

  it('reads a size phrase as a size, never as a price', () => {
    const parsed = parse('size 42 under 50k');
    expect(parsed.filters.sizes).toEqual(['42']);
    expect(parsed.filters.price).toEqual({ max: 50000 });
  });

  it('corrects a one-edit typo on a lexicon term and records it', () => {
    const parsed = parse('agbda');
    expect(parsed.filters.categoryIds).toEqual([id(2)]);
    expect(parsed.corrections).toEqual([
      expect.objectContaining({ from: 'agbda', to: 'agbada', applied: true }),
    ]);
  });

  it('lets an explicit request filter override the parsed one', () => {
    const parsed = parse('red dress', {
      explicitKeys: new Set(['colors']),
    });
    expect(parsed.filters.colors).toBeUndefined();
    expect(
      parsed.attributes.find((item) => item.type === 'color')?.applied,
    ).toBe('overridden');
  });

  it('keeps a literal span as text when the shopper asks for it', () => {
    const parsed = parse('red dress', { literals: ['red'] });
    expect(parsed.filters.colors).toBeUndefined();
    expect(parsed.residual).toContain('red');
  });

  it('treats hostile input as plain words and never throws', () => {
    for (const hostile of [
      "'; DROP TABLE x;--",
      'a%b_c',
      '\u0000\u202e',
      '🔥🔥🔥',
      'x'.repeat(5000),
      '',
    ]) {
      const parsed = parse(hostile);
      expect(parsed.residual).not.toMatch(/[%_;'\\]/);
      expect(parsed.residual.length).toBeLessThanOrEqual(200);
    }
  });

  it('bounds the number of content tokens and reports truncation', () => {
    const parsed = parse(
      Array.from({ length: 30 }, (_, n) => `word${n}`).join(' '),
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.residualGroups.length).toBeLessThanOrEqual(12);
  });

  it('parses with no lexicon at all, keeping every word as text', () => {
    const parsed = parseSearchQuery('black evening dress', null);
    expect(parsed.filters).toEqual({});
    expect(parsed.residual).toBe('black evening dress');
    expect(parsed.lexiconVersion).toBeNull();
  });

  it('expands a synonym into one alternative group', () => {
    const parsed = parse('gown floral');
    expect(parsed.residualGroups.length).toBeGreaterThan(0);
  });
});
