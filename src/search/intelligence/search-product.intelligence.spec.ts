import { BadRequestException } from '@nestjs/common';
import { buildSearchLexiconBlob } from '../lexicon/search-lexicon-blob';
import { SearchLexiconReader } from '../lexicon/search-lexicon.reader';
import { SEARCH_LEXICON_LIMITS } from '../lexicon/search-lexicon.types';
import type { SearchLexiconSourceRow } from '../lexicon/search-lexicon-source.sql';
import {
  parseSearchProductRequest,
  searchLexiconEnabled,
} from './search-product.intelligence';

const row = (
  kind: SearchLexiconSourceRow['kind'],
  value: string,
  label: string | null = null,
): SearchLexiconSourceRow => ({
  kind,
  value,
  label,
  names: null,
  count: 3,
  dimension: null,
  categoryId: null,
  p30: null,
  p80: null,
});

const blobAt = (sourceAsOf: Date) =>
  JSON.stringify(
    buildSearchLexiconBlob(
      [row('color', 'red', 'Red'), row('word', 'agbada')],
      {
        sourceAsOf,
        builtAt: sourceAsOf,
        maxRows: 100,
      },
    ),
  );

const readerOver = (values: Array<string | null | Error>) => {
  const queryRaw = jest.fn(async () => {
    const next = values.length > 1 ? values.shift()! : values[0];
    if (next instanceof Error) throw next;
    return next === null ? [] : [{ value: next }];
  });
  return {
    reader: new SearchLexiconReader({ $queryRaw: queryRaw } as never),
    queryRaw,
  };
};

describe('search lexicon flag', () => {
  const previous = process.env.SEARCH_LEXICON_V1;
  afterEach(() => {
    if (previous === undefined) delete process.env.SEARCH_LEXICON_V1;
    else process.env.SEARCH_LEXICON_V1 = previous;
  });

  it('is on only for exactly "true"', () => {
    for (const value of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      if (value === undefined) delete process.env.SEARCH_LEXICON_V1;
      else process.env.SEARCH_LEXICON_V1 = value;
      expect(searchLexiconEnabled()).toBe(false);
    }
    process.env.SEARCH_LEXICON_V1 = 'true';
    expect(searchLexiconEnabled()).toBe(true);
  });
});

describe('parseSearchProductRequest', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      return ((error as BadRequestException).getResponse() as { code?: string })
        .code;
    }
    throw new Error('expected a rejection');
  };

  it('defaults to relevance with no filters or facets', () => {
    const request = parseSearchProductRequest({});
    expect(request.sort).toBe('relevance');
    expect(request.filters).toEqual({});
    expect(request.includeFacets).toBe(false);
  });

  it('rejects unknown sorts and facet toggles with stable codes', () => {
    expect(code(() => parseSearchProductRequest({ sort: 'cheapest' }))).toBe(
      'UNSUPPORTED_SORT',
    );
    expect(code(() => parseSearchProductRequest({ includeFacets: '2' }))).toBe(
      'INVALID_FILTER',
    );
    expect(code(() => parseSearchProductRequest({ filters: 'nope=1' }))).toBe(
      'INVALID_FILTER',
    );
  });

  it('keys equivalent filter encodings identically', () => {
    const left = parseSearchProductRequest({ filters: 'color=red&size=42' });
    const right = parseSearchProductRequest({ filters: 'size=42&color=red' });
    expect(left.filterKey).toBe(right.filterKey);
    expect(left.filterKey).not.toBe(parseSearchProductRequest({}).filterKey);
  });
});

describe('SearchLexiconReader', () => {
  const now = Date.parse('2026-11-26T12:00:00.000Z');
  const { reloadMs, maxAgeMs } = SEARCH_LEXICON_LIMITS;

  it('returns null when no lexicon has been built', async () => {
    const { reader } = readerOver([null]);
    await expect(reader.index(now)).resolves.toBeNull();
  });

  it('shares one read per reload interval across requests', async () => {
    const { reader, queryRaw } = readerOver([blobAt(new Date(now))]);
    const [a, b] = await Promise.all([reader.index(now), reader.index(now)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    await reader.index(now + reloadMs - 1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    await reader.index(now + reloadMs);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good lexicon when a reload fails or is malformed', async () => {
    const { reader, queryRaw } = readerOver([
      blobAt(new Date(now)),
      new Error('connection reset'),
      '{"schema":"tampered"}',
    ]);
    const first = await reader.index(now);
    expect(first).not.toBeNull();
    expect(await reader.index(now + reloadMs)).toBe(first);
    expect(await reader.index(now + 2 * reloadMs)).toBe(first);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('stops serving a lexicon once it passes its age limit', async () => {
    const { reader } = readerOver([blobAt(new Date(now))]);
    expect(await reader.index(now)).not.toBeNull();
    await expect(reader.index(now + maxAgeMs + 1)).resolves.toBeNull();
  });
});
