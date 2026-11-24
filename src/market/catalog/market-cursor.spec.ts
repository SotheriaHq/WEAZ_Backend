import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  MarketCursorCodec,
  MarketCursorExpectedContext,
  MarketCursorState,
  MARKET_CURSOR_TTL_MS,
  MARKET_CURSOR_MAX_LENGTH,
  parseMarketSnapshot,
} from './market-cursor';

const SECRET = 'current-cursor-fixture-key-with-32-bytes';
const OLD = 'previous-cursor-fixture-key-with-32-bytes';
const NS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const expected: MarketCursorExpectedContext = {
  requestedSort: 'newest',
  filterHash: 'a'.repeat(64),
  scopeContext: 'catalog:spec=3:policy=1:query-hash=none',
  viewerContext: 'fixture-user:suppression-revision=7',
};
const state = (
  codec: MarketCursorCodec,
  updates: Partial<MarketCursorState> = {},
): MarketCursorState => ({
  v: 1,
  namespace: NS,
  requestedSort: 'newest',
  sort: 'newest',
  filterHash: expected.filterHash,
  scopeHash: codec.contextHash('scope', expected.scopeContext),
  viewerHash: codec.contextHash('viewer', expected.viewerContext),
  asOf: NOW,
  expiresAt: NOW + MARKET_CURSOR_TTL_MS,
  key: ['2026-11-20T10:00:00.000Z', ID],
  epoch: null,
  price: null,
  ...updates,
});
// Sign malformed fixtures so negative tests exercise post-authentication parsing too.
const sign = (value: unknown, secret = SECRET) => {
  const body = Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');
  const key = createHmac('sha256', secret)
    .update('aru:market:cursor:v1\0')
    .digest();
  return (
    body + '.' + createHmac('sha256', key).update(body).digest('base64url')
  );
};

describe('bounded authenticated Market cursors', () => {
  const codec = new MarketCursorCodec(SECRET, NS);
  it('permits an authenticated epoch pin on an ordered section while preserving scope binding', () => {
    const pinned = state(codec, {
      epoch: { id: ID, generation: '1', featureVersion: 1, policyVersion: 1 },
    });
    const token = codec.encode(pinned);
    const result = codec.decode(token, expected, NOW);
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid')
      expect(result.cursor.epoch).toEqual(pinned.epoch);
    expect(() =>
      codec.decode(token, { ...expected, scopeContext: 'other-section' }, NOW),
    ).toThrow(BadRequestException);
  });
  it('round trips frozen newest state without including raw viewer or section context', () => {
    const cursor = state(codec),
      token = codec.encode(cursor);
    const result = codec.decode(token, expected, NOW);
    expect(result).toEqual({ kind: 'valid', cursor });
    if (result.kind === 'valid') {
      expect(Object.isFrozen(result.cursor)).toBe(true);
      expect(Object.isFrozen(result.cursor.key)).toBe(true);
    }
    const visible = Buffer.from(token.split('.')[0], 'base64url').toString();
    expect(visible).not.toContain('fixture-user');
    expect(visible).not.toContain('catalog:spec');
  });
  it('pins the effective fallback rather than silently changing sorting between pages', () => {
    const cursor = state(codec, { requestedSort: 'popular', sort: 'newest' });
    expect(
      codec.decode(
        codec.encode(cursor),
        { ...expected, requestedSort: 'popular' },
        NOW,
      ),
    ).toEqual({ kind: 'valid', cursor });
  });
  it('accepts all score key forms with an exact immutable generation', () => {
    const epoch = {
      id: ID,
      generation: '1001',
      featureVersion: 2,
      policyVersion: 3,
    };
    for (const [sort, key] of [
      ['popular', [3.5, ID]],
      ['trending', [1, -0.4, 2.5, ID]],
      ['trending', [0, null, 2.5, ID]],
      ['best_selling', [27, ID]],
      ['most_saved', [100, ID]],
      ['recommended', [0.1, ID]],
    ] as const) {
      const cursor = state(codec, { requestedSort: sort, sort, key, epoch });
      expect(
        codec.decode(
          codec.encode(cursor),
          { ...expected, requestedSort: sort },
          NOW,
        ),
      ).toEqual({ kind: 'valid', cursor });
    }
  });
  it('rejects a correctly signed non-trending tail key carrying a trend score', () => {
    const cursor = state(codec, {
      requestedSort: 'trending',
      sort: 'trending',
      key: [0, 1, 2.5, ID],
      epoch: {
        id: ID,
        generation: '1001',
        featureVersion: 2,
        policyVersion: 3,
      },
    });
    expect(() =>
      codec.decode(
        sign(cursor),
        { ...expected, requestedSort: 'trending' },
        NOW,
      ),
    ).toThrow(BadRequestException);
  });
  it('holds price amount, transaction snapshot and exact clock boundary', () => {
    const cursor = state(codec, {
      requestedSort: 'price_asc',
      sort: 'price_asc',
      key: ['12000.01', ID],
      price: { snapshot: '100:110:101,105', nextChangeAt: NOW + 1 },
    });
    const token = codec.encode(cursor),
      context = { ...expected, requestedSort: 'price_asc' as const };
    expect(codec.decode(token, context, NOW).kind).toBe('valid');
    expect(codec.decode(token, context, NOW + 1)).toEqual({
      kind: 'reanchor',
      reason: 'PRICE_BOUNDARY',
      notice: 'Prices updated',
    });
  });
  it('keeps a sale valid through its inclusive end millisecond', () => {
    const cursor = state(codec, {
      requestedSort: 'price_desc',
      sort: 'price_desc',
      key: ['80.00', ID],
      price: { snapshot: '100:100:', nextChangeAt: NOW + 1001 },
    });
    const context = { ...expected, requestedSort: 'price_desc' as const },
      token = codec.encode(cursor);
    expect(codec.decode(token, context, NOW + 1000).kind).toBe('valid');
    expect(codec.decode(token, context, NOW + 1001).kind).toBe('reanchor');
  });
  it('distinguishes authenticated expiry and restore from malformed cursors', () => {
    const token = codec.encode(state(codec));
    expect(codec.decode(token, expected, NOW + MARKET_CURSOR_TTL_MS)).toEqual({
      kind: 'reanchor',
      reason: 'CURSOR_EXPIRED',
      notice: 'Updated',
    });
    const restored = new MarketCursorCodec(SECRET, ID);
    expect(restored.decode(token, expected, NOW)).toEqual({
      kind: 'reanchor',
      reason: 'RESTORE_CHANGED',
      notice: 'Updated',
    });
  });
  it('accepts the previous key and corresponding context hashes during rotation', () => {
    const previous = new MarketCursorCodec(OLD, NS),
      rotated = new MarketCursorCodec(SECRET, NS, OLD);
    const token = previous.encode(state(previous));
    expect(rotated.decode(token, expected, NOW).kind).toBe('valid');
    expect(() => codec.decode(token, expected, NOW)).toThrow(
      BadRequestException,
    );
    expect(() =>
      previous.decode(rotated.encode(state(rotated)), expected, NOW),
    ).toThrow(BadRequestException);
  });
  it.each([
    { filterHash: 'b'.repeat(64) },
    { scopeContext: 'catalog:spec=4' },
    { viewerContext: 'other-user:suppression-revision=7' },
    { viewerContext: 'fixture-user:suppression-revision=8' },
    { requestedSort: 'popular' as const },
  ])('rejects changed request context even when expired: %j', (changes) => {
    expect(() =>
      codec.decode(
        codec.encode(state(codec)),
        { ...expected, ...changes },
        NOW + MARKET_CURSOR_TTL_MS,
      ),
    ).toThrow(BadRequestException);
  });
  it.each([
    '',
    '.',
    'abc',
    'abc.def.ghi',
    'a'.repeat(MARKET_CURSOR_MAX_LENGTH + 1),
    'a.b',
    'abc=.def',
    'abc.' + 'A'.repeat(42),
    'abc.' + 'A'.repeat(44),
  ])('rejects bounded malformed token syntax', (token) => {
    expect(() => codec.decode(token, expected, NOW)).toThrow(
      BadRequestException,
    );
  });
  it('rejects tampering without returning any signed claims', () => {
    const token = codec.encode(state(codec));
    const [body, signature] = token.split('.');
    expect(() =>
      codec.decode(
        body + '.' + (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1),
        expected,
        NOW,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      codec.decode(
        sign({ ...state(codec), filterHash: 'b'.repeat(64) }, OLD),
        expected,
        NOW,
      ),
    ).toThrow(BadRequestException);
  });
  it.each([
    { v: 2 },
    { extra: true },
    { namespace: 'bad' },
    { requestedSort: 'most_liked' },
    { sort: 'unknown' },
    { filterHash: 'bad' },
    { viewerHash: 'bad' },
    { scopeHash: 'bad' },
    { asOf: NOW + 30001, expiresAt: NOW + 30002 },
    { asOf: 0 },
    { expiresAt: NOW },
    { expiresAt: NOW + MARKET_CURSOR_TTL_MS + 1 },
    { epoch: {} },
    { price: {} },
    { key: ['invalid-date', ID] },
    { key: ['2026-11-20T10:00:00.000Z', 'bad'] },
    { key: ['2026-11-20T10:00:00.000Z', ID, ID] },
    {
      sort: 'price_asc',
      key: [80, ID],
      price: { snapshot: '1:1:', nextChangeAt: null },
    },
    {
      sort: 'price_asc',
      key: ['80.001', ID],
      price: { snapshot: '1:1:', nextChangeAt: null },
    },
    {
      sort: 'price_asc',
      key: ['80.00', ID],
      price: { snapshot: '1:1:', nextChangeAt: NOW },
    },
    { sort: 'popular', key: [1, ID], epoch: null },
    {
      sort: 'popular',
      key: [1, ID],
      epoch: { id: ID, generation: '0', featureVersion: 1, policyVersion: 1 },
    },
    {
      sort: 'most_saved',
      key: [-1, ID],
      epoch: { id: ID, generation: '1', featureVersion: 1, policyVersion: 1 },
    },
    {
      sort: 'best_selling',
      key: [0.5, ID],
      epoch: { id: ID, generation: '1', featureVersion: 1, policyVersion: 1 },
    },
  ])('rejects authenticated invalid claims: %j', (changes) => {
    expect(() =>
      codec.decode(sign({ ...state(codec), ...changes }), expected, NOW),
    ).toThrow(BadRequestException);
  });
  it('rejects correctly signed malformed JSON and noncanonical base64url', () => {
    expect(() => codec.decode(sign('{'), expected, NOW)).toThrow(
      BadRequestException,
    );
    const token = codec.encode(state(codec));
    expect(() =>
      codec.decode(
        token.split('.')[0] + '=.' + token.split('.')[1],
        expected,
        NOW,
      ),
    ).toThrow(BadRequestException);
  });
  it('requires valid configuration without sharing authentication keys', () => {
    expect(() => new MarketCursorCodec('short', NS)).toThrow(
      'at least 32 bytes',
    );
    expect(() => new MarketCursorCodec(SECRET, 'bad')).toThrow('namespace');
    expect(() => new MarketCursorCodec(SECRET, NS, '')).toThrow();
    expect(() => codec.contextHash('viewer', 'a'.repeat(8193))).toThrow(
      RangeError,
    );
  });
  it('rejects invalid internal state on encode as well', () => {
    expect(() => codec.encode({ ...state(codec), namespace: ID })).toThrow(
      'namespace',
    );
    expect(() => codec.encode({ ...state(codec), key: [] })).toThrow(
      BadRequestException,
    );
  });
});

describe('bounded top-level PostgreSQL snapshot contract', () => {
  it('accepts xid8 values without converting to lossy JS numbers', () => {
    expect(
      parseMarketSnapshot(
        '9007199254740993:9007199254740996:9007199254740993,9007199254740995',
      ),
    ).toEqual({
      xmin: '9007199254740993',
      xmax: '9007199254740996',
      active: ['9007199254740993', '9007199254740995'],
    });
    expect(parseMarketSnapshot('10:10:').active).toEqual([]);
    expect(
      parseMarketSnapshot('18446744073709551615:18446744073709551615:').xmin,
    ).toBe('18446744073709551615');
  });
  it.each([
    '',
    '1:2',
    '2:1:',
    '1:2:2',
    '1:3:2,1',
    '1:3:1,1',
    '01:2:',
    '1:2:-1',
    '1:2:NaN',
    '1:18446744073709551616:',
    '1:3:1,',
    '1:3:0',
  ])('rejects malformed snapshot %s', (snapshot) => {
    expect(() => parseMarketSnapshot(snapshot)).toThrow(BadRequestException);
  });
  it('enforces a transaction-count budget before expensive database work', () => {
    expect(
      parseMarketSnapshot(
        '1:300:' +
          Array.from({ length: 256 }, (_, i) => String(i + 1)).join(','),
      ).active,
    ).toHaveLength(256);
    expect(() =>
      parseMarketSnapshot(
        '1:300:' +
          Array.from({ length: 257 }, (_, i) => String(i + 1)).join(','),
      ),
    ).toThrow(BadRequestException);
    expect(() => parseMarketSnapshot('1:300:' + '1'.repeat(6201))).toThrow(
      BadRequestException,
    );
  });
});
