import {
  PipelineSectionCursorCodec,
  pipelineSourceKeyAfterSql,
  pipelineSourceKeyOrderSql,
  validatePipelineSourceKey,
} from './market-pipeline.section-cursor';
import { pipelineSourcePageSql } from './market-pipeline.section-reader';
import { PipelineSource, PipelineSourceRequest } from './market-pipeline.types';

const secret = 'source-page-test-key-with-at-least-thirty-two-bytes';
const namespace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const now = Date.parse('2026-11-22T12:00:00.000Z');
const source: PipelineSource = { kind: 'curated', placementKey: 'STYLE_PICKS' };
const codec = () => new PipelineSectionCursorCodec(secret, namespace);
const value = () =>
  codec().state({
    binding: codec().binding({ viewer: 'first', filters: 'red' }),
    sourceHash: 'a'.repeat(64),
    revision: '20:12345:-6789',
    asOf: now,
    expiresAt: now + 3600000,
    key: [1, new Date(now).toISOString(), id],
  });
const request = (input: PipelineSource): PipelineSourceRequest => ({
  sectionKey: 'style-picks',
  source: input,
  fixedFilterLayers: [{ tags: ['adire'] }],
  filters: { colors: ['Red'] },
  epoch: null,
  asOf: new Date(now),
  limit: 100,
  signal: new AbortController().signal,
});

describe('source-bound section cursors and full-set keysets', () => {
  it('authenticates valid state and rejects tampering before database work', () => {
    const state = value(),
      token = codec().encode(state);
    expect(codec().authenticate(token)).toEqual(state);
    expect(
      codec().decode(token, state.binding, state.revision, now + 1),
    ).toEqual({ kind: 'valid', cursor: state });
    expect(() =>
      codec().authenticate(token.replace(/^./, token[0] === 'a' ? 'b' : 'a')),
    ).toThrow();
    expect(() => codec().authenticate('bad')).toThrow();
    expect(() => codec().authenticate('a'.repeat(4097))).toThrow();
  });
  it('binds viewer/filter identity, accepts the previous signing key, and reanchors source revisions and restore namespaces', () => {
    const state = value(),
      token = codec().encode(state);
    const rotated = new PipelineSectionCursorCodec(
      'replacement-key-with-at-least-thirty-two-bytes',
      namespace,
      secret,
    );
    expect(
      rotated.decode(
        token,
        rotated.binding({ viewer: 'first', filters: 'red' }),
        state.revision,
        now + 1,
      ).kind,
    ).toBe('valid');
    expect(() =>
      codec().decode(
        token,
        codec().binding({ viewer: 'second', filters: 'red' }),
        state.revision,
        now + 1,
      ),
    ).toThrow();
    expect(
      codec().decode(token, state.binding, '20:changed', now + 1).kind,
    ).toBe('reanchor');
    expect(
      codec().decode(token, state.binding, state.revision, state.expiresAt)
        .kind,
    ).toBe('reanchor');
    const restored = new PipelineSectionCursorCodec(
      secret,
      '33333333-3333-4333-8333-333333333333',
    );
    expect(
      restored.decode(token, state.binding, state.revision, now + 1).kind,
    ).toBe('reanchor');
  });
  it.each([
    {},
    null,
    [],
    { ...value(), key: [null, id] },
    { ...value(), asOf: NaN },
    { ...value(), expiresAt: now + 21600001 },
    { ...value(), binding: 'raw-viewer' },
    { ...value(), injected: 'ignored' },
  ])('rejects malformed signed state %j', (state) => {
    const token = codec().encode(state as never);
    expect(() => codec().authenticate(token)).toThrow();
  });
  it('uses actual curator/stock/similarity/look tuples, never a preview ordinal cursor', () => {
    const sql = pipelineSourceKeyAfterSql(source, [
      1,
      new Date(now).toISOString(),
      id,
    ]);
    expect(sql.values).toContain(id);
    expect(sql.text).not.toContain(id);
    expect(sql.text).toContain('::numeric');
    expect(sql.text).toContain('::timestamptz');
    expect(sql.text).toContain('::uuid');
    expect(
      pipelineSourceKeyOrderSql({
        kind: 'looks',
        minEligibleProducts: 2,
        minEligibleRatio: 0.7,
      }).text.match(/ASC|DESC/g),
    ).toEqual(['ASC', 'DESC', 'DESC', 'ASC']);
    expect(() =>
      validatePipelineSourceKey({ kind: 'low_stock', threshold: 3 }, [
        0,
        id,
        'extra',
      ]),
    ).toThrow();
    expect(() =>
      validatePipelineSourceKey({ kind: 'similar', productId: id }, [
        NaN,
        new Date(now).toISOString(),
        id,
      ]),
    ).toThrow();
  });
  it.each<PipelineSource>([
    source,
    { kind: 'low_stock', threshold: 3 },
    { kind: 'similar', productId: id },
    { kind: 'complements', productId: id },
    { kind: 'from_runway' },
    { kind: 'looks', minEligibleProducts: 2, minEligibleRatio: 0.7 },
    { kind: 'new_designers', maxAgeDays: 180, minEligibleProducts: 3 },
    { kind: 'category_tiles', minEligibleProducts: 2 },
  ])('seeks the full %j source without materializing its universe', (input) => {
    const sql = pipelineSourcePageSql({
      request: request(input),
      viewer: {},
      limit: 21,
    });
    expect(sql.text).not.toContain('selected AS MATERIALIZED');
    expect(sql.text).not.toContain('hashtextextended');
    expect(sql.text).not.toMatch(/OFFSET|row_number\(\) OVER/);
    expect(sql.values).toContain(21);
    // Source keys exclude public card tag/dimension arrays over the universe.
    expect(sql.text).not.toContain("'brandCreatedAt'");
    expect(sql.text).toContain('jsonb_build_array');
  });
  it('rejects supplied preview IDs and unbounded page transfer', () => {
    expect(() =>
      pipelineSourcePageSql({
        request: { ...request(source), cachedIds: [id] },
        viewer: {},
        limit: 21,
      }),
    ).toThrow();
    expect(() =>
      pipelineSourcePageSql({
        request: request(source),
        viewer: {},
        limit: 62,
      }),
    ).toThrow();
  });
});
