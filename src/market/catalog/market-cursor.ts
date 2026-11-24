import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MARKET_CURSOR_MAX_LENGTH = 12288;
export const MARKET_CURSOR_TTL_MS = 6 * 60 * 60 * 1000;
export const MARKET_SNAPSHOT_MAX_TRANSACTIONS = 256;
export const MARKET_SNAPSHOT_MAX_LENGTH = 6200;
export const MARKET_SORTS = [
  'newest',
  'popular',
  'trending',
  'price_asc',
  'price_desc',
  'best_selling',
  'most_saved',
  'recommended',
  'relevance',
] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export type MarketCursorKey = readonly (string | number | null)[];

export interface MarketCursorContext {
  readonly requestedSort: MarketSort;
  readonly filterHash: string;
  readonly scopeHash: string;
  readonly viewerHash: string;
}
export interface MarketCursorExpectedContext {
  readonly requestedSort: MarketSort;
  readonly filterHash: string;
  readonly scopeContext: string;
  readonly viewerContext: string;
}
export interface MarketCursorEpoch {
  readonly id: string;
  readonly generation: string;
  readonly featureVersion: number;
  readonly policyVersion: number;
}
export interface MarketCursorState extends MarketCursorContext {
  readonly v: 1;
  readonly namespace: string;
  readonly sort: MarketSort;
  readonly asOf: number;
  readonly expiresAt: number;
  readonly key: MarketCursorKey;
  readonly epoch: MarketCursorEpoch | null;
  readonly price: Readonly<{
    snapshot: string;
    nextChangeAt: number | null;
  }> | null;
}
export type DecodedMarketCursor =
  | { kind: 'valid'; cursor: MarketCursorState }
  | {
      kind: 'reanchor';
      reason: 'CURSOR_EXPIRED' | 'RESTORE_CHANGED' | 'PRICE_BOUNDARY';
      notice: 'Updated' | 'Prices updated';
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const money = /^(?:0|[1-9][0-9]{0,7})\.[0-9]{2}$/;
const uint64 = /^(?:0|[1-9][0-9]{0,19})$/;
const maxXid = 18446744073709551615n;
const isPrice = (sort: MarketSort) =>
  sort === 'price_asc' || sort === 'price_desc';
const isScore = (sort: MarketSort) =>
  !['newest', 'price_asc', 'price_desc', 'relevance'].includes(sort);
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && digest.test(value);

function invalid(): never {
  throw new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'Refresh this list to continue.',
  });
}
function record(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}
function xid(value: string): boolean {
  return uint64.test(value) && BigInt(value) <= maxXid;
}

/** PostgreSQL emits ordered top-level IDs. Never accept subtransaction metadata. */
export function parseMarketSnapshot(snapshot: string): {
  xmin: string;
  xmax: string;
  active: readonly string[];
} {
  if (
    typeof snapshot !== 'string' ||
    snapshot.length > MARKET_SNAPSHOT_MAX_LENGTH
  )
    invalid();
  const parts = snapshot.split(':');
  if (parts.length !== 3 || !xid(parts[0]) || !xid(parts[1])) invalid();
  const [xmin, xmax, body] = parts;
  const active = body ? body.split(',') : [];
  if (
    active.length > MARKET_SNAPSHOT_MAX_TRANSACTIONS ||
    BigInt(xmin) > BigInt(xmax)
  )
    invalid();
  let previous = BigInt(xmin) - 1n;
  for (const entry of active) {
    if (!xid(entry)) invalid();
    const current = BigInt(entry);
    if (
      current < BigInt(xmin) ||
      current >= BigInt(xmax) ||
      current <= previous
    )
      invalid();
    previous = current;
  }
  return { xmin, xmax, active: Object.freeze(active) };
}

export function isMarketSortKey(
  sort: MarketSort,
  key: unknown,
): key is MarketCursorKey {
  if (!Array.isArray(key) || !id(key[key.length - 1])) return false;
  if (sort === 'newest') {
    if (key.length !== 2 || typeof key[0] !== 'string' || key[0].length !== 24)
      return false;
    const date = new Date(key[0]);
    return Number.isFinite(date.getTime()) && date.toISOString() === key[0];
  }
  if (isPrice(sort))
    return key.length === 2 && typeof key[0] === 'string' && money.test(key[0]);
  if (sort === 'best_selling' || sort === 'most_saved')
    return key.length === 2 && integer(key[0], 0, 2147483647);
  if (sort === 'trending')
    return (
      key.length === 4 &&
      (key[0] === 0 || key[0] === 1) &&
      (key[1] === null || finite(key[1])) &&
      finite(key[2]) &&
      key[2] >= 0 &&
      (key[0] === 0 ? key[1] === null : finite(key[1]))
    );
  if (sort === 'relevance')
    return key.length === 3 && integer(key[0], 0, 3) && finite(key[1]);
  return key.length === 2 && finite(key[0]) && key[0] >= 0;
}

function validate(value: unknown): MarketCursorState {
  if (
    !record(value, [
      'v',
      'namespace',
      'requestedSort',
      'sort',
      'filterHash',
      'scopeHash',
      'viewerHash',
      'asOf',
      'expiresAt',
      'key',
      'epoch',
      'price',
    ]) ||
    value.v !== 1 ||
    !id(value.namespace) ||
    !hash(value.filterHash) ||
    !hash(value.scopeHash) ||
    !hash(value.viewerHash) ||
    !MARKET_SORTS.includes(value.sort as MarketSort) ||
    !MARKET_SORTS.includes(value.requestedSort as MarketSort) ||
    !integer(value.asOf, 1, 8640000000000000) ||
    !integer(value.expiresAt, 1, 8640000000000000) ||
    value.expiresAt <= value.asOf ||
    value.expiresAt - value.asOf > MARKET_CURSOR_TTL_MS ||
    !isMarketSortKey(value.sort as MarketSort, value.key)
  )
    invalid();
  const sort = value.sort as MarketSort;
  if (isScore(sort) || value.epoch !== null) {
    if (
      !record(value.epoch, [
        'id',
        'generation',
        'featureVersion',
        'policyVersion',
      ]) ||
      !id(value.epoch.id) ||
      typeof value.epoch.generation !== 'string' ||
      !xid(value.epoch.generation) ||
      BigInt(value.epoch.generation) < 1n ||
      !integer(value.epoch.featureVersion, 1, 2147483647) ||
      !integer(value.epoch.policyVersion, 1, 2147483647)
    )
      invalid();
  }
  if (isPrice(sort)) {
    if (
      !record(value.price, ['snapshot', 'nextChangeAt']) ||
      typeof value.price.snapshot !== 'string' ||
      (value.price.nextChangeAt !== null &&
        (!integer(value.price.nextChangeAt, 1, 8640000000000000) ||
          value.price.nextChangeAt <= value.asOf))
    )
      invalid();
    parseMarketSnapshot(value.price.snapshot);
  } else if (value.price !== null) invalid();
  return value as unknown as MarketCursorState;
}

/** A cursor authenticates ordering state; it never authorizes a product read. */
export class MarketCursorCodec {
  private readonly keys: readonly Buffer[];
  constructor(
    currentSecret: string,
    private readonly namespace: string,
    previousSecret?: string,
  ) {
    if (!id(namespace))
      throw new Error('Invalid market cursor namespace configuration');
    const secrets =
      previousSecret === undefined
        ? [currentSecret]
        : [currentSecret, previousSecret];
    if (
      secrets.some(
        (secret) =>
          typeof secret !== 'string' ||
          Buffer.byteLength(secret, 'utf8') < 32 ||
          Buffer.byteLength(secret, 'utf8') > 1024,
      )
    )
      throw new Error('Market cursor secrets must contain at least 32 bytes');
    this.keys = [...new Set(secrets)].map((secret) =>
      createHmac('sha256', secret).update('aru:market:cursor:v1\0').digest(),
    );
  }

  /** Use for server-owned viewer/scope inputs; no raw identifiers enter tokens. */
  contextHash(domain: 'viewer' | 'scope', canonicalContext: string): string {
    return this.contextHashWith(this.keys[0], domain, canonicalContext);
  }

  private contextHashWith(
    key: Buffer,
    domain: 'viewer' | 'scope',
    canonicalContext: string,
  ): string {
    if (
      typeof canonicalContext !== 'string' ||
      Buffer.byteLength(canonicalContext) > 8192
    )
      throw new RangeError('Market cursor context exceeds its budget');
    return createHmac('sha256', key)
      .update(domain)
      .update('\0')
      .update(canonicalContext)
      .digest('hex');
  }

  encode(state: MarketCursorState): string {
    const cursor = validate(state);
    if (cursor.namespace !== this.namespace)
      throw new Error('Cursor namespace does not match configuration');
    const json = JSON.stringify(cursor);
    if (Buffer.byteLength(json, 'utf8') > 9000) invalid();
    const body = Buffer.from(json).toString('base64url');
    const signature = createHmac('sha256', this.keys[0])
      .update(body)
      .digest('base64url');
    const token = body + '.' + signature;
    if (token.length > MARKET_CURSOR_MAX_LENGTH) invalid();
    return token;
  }

  private authenticated(token: string): {
    cursor: MarketCursorState;
    verifiedKey: Buffer;
  } {
    if (typeof token !== 'string' || token.length > MARKET_CURSOR_MAX_LENGTH)
      invalid();
    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    )
      invalid();
    const body = Buffer.from(parts[0], 'base64url');
    const signature = Buffer.from(parts[1], 'base64url');
    if (
      body.length > 9000 ||
      body.toString('base64url') !== parts[0] ||
      signature.toString('base64url') !== parts[1]
    )
      invalid();
    let verifiedKey: Buffer | undefined;
    // Check all accepted keys; rotation does not reveal which one matched.
    for (const key of this.keys) {
      const candidate = createHmac('sha256', key).update(parts[0]).digest();
      if (timingSafeEqual(candidate, signature)) verifiedKey = key;
    }
    if (!verifiedKey) invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      invalid();
    }
    const cursor = validate(parsed);
    return { cursor, verifiedKey };
  }

  /** Reject tampered/oversized state before acquiring a database connection. */
  authenticate(token: string): void {
    this.authenticated(token);
  }

  decode(
    token: string,
    expected: MarketCursorExpectedContext,
    now = Date.now(),
  ): DecodedMarketCursor {
    if (!integer(now, 1, 8640000000000000))
      throw new RangeError('Invalid cursor verification clock');
    const { cursor, verifiedKey } = this.authenticated(token);
    if (
      cursor.asOf > now + 30000 ||
      cursor.requestedSort !== expected.requestedSort ||
      cursor.filterHash !== expected.filterHash ||
      cursor.scopeHash !==
        this.contextHashWith(verifiedKey, 'scope', expected.scopeContext) ||
      cursor.viewerHash !==
        this.contextHashWith(verifiedKey, 'viewer', expected.viewerContext)
    )
      invalid();
    if (cursor.namespace !== this.namespace)
      return { kind: 'reanchor', reason: 'RESTORE_CHANGED', notice: 'Updated' };
    if (cursor.expiresAt <= now)
      return { kind: 'reanchor', reason: 'CURSOR_EXPIRED', notice: 'Updated' };
    if (
      cursor.price?.nextChangeAt !== null &&
      cursor.price &&
      cursor.price.nextChangeAt <= now
    )
      return {
        kind: 'reanchor',
        reason: 'PRICE_BOUNDARY',
        notice: 'Prices updated',
      };
    Object.freeze(cursor.key);
    if (cursor.epoch) Object.freeze(cursor.epoch);
    if (cursor.price) Object.freeze(cursor.price);
    return { kind: 'valid', cursor: Object.freeze(cursor) };
  }
}
