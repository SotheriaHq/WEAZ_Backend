import {
  RedisPipelineCandidateCache,
  createPipelineExposureReceipt,
  pipelineExposureKeys,
  serializePipelinePage,
  writePipelineExposures,
} from './market-pipeline.delivery';
import { PipelineSection } from './market-pipeline.types';

const id = '11111111-1111-4111-8111-111111111111';
describe('Market pipeline delivery adapters', () => {
  it('strips trusted scopes and exposure anchors from the public page', () => {
    const page = {
      generatedAt: '2026-11-21T12:00:00.000Z',
      epoch: null,
      metadata: { partial: false, cachePolicy: 'private-no-store' as const },
      sections: [
        {
          key: 'example',
          template: 'CATALOG_FILTER',
          title: 'Explore',
          subtitle: null,
          policy: 'recency',
          policyVersion: 1,
          personalization: 'none',
          items: [],
          viewAll: {},
          metadata: {},
          scope: { source: { kind: 'curated', placementKey: 'INTERNAL' } },
          exposures: [{ productId: id, position: 0 }],
        } as unknown as PipelineSection,
      ],
    };
    const output = JSON.stringify(serializePipelinePage(page));
    expect(output).not.toContain('INTERNAL');
    expect(output).not.toContain('exposures');
    expect(output).not.toContain('scope');
    expect(serializePipelinePage(page).sections[0]).toMatchObject({
      reason: null,
      layout: 'HORIZONTAL_RAIL',
      viewAll: { route: '/market/sections/example', label: 'View all' },
    });
  });
  it('writes anonymous exposure rows outside read capture and remains retry-idempotent', async () => {
    const db = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const section = {
      key: 'hot-right-now',
      template: 'TREND',
      items: [{ id, entityType: 'PRODUCT', position: 0 }],
    } as unknown as PipelineSection;
    const input = { epoch: null, asOf: new Date('2026-11-21T13:00:00.000Z') };
    const receipt = createPipelineExposureReceipt([section], input);
    expect(await writePipelineExposures(db, receipt)).toBe(1);
    await expect(
      writePipelineExposures(db, { kind: 'market-pipeline-exposure-receipt' }),
    ).rejects.toThrow('Invalid exposure receipt');
    const query = db.$executeRaw.mock.calls[0][0];
    expect(query.text).toContain('ON CONFLICT');
    expect(query.text).toContain('DO NOTHING');
    expect(query.values).toContain('2026-11-21T12:00:00.000Z');
    expect(query.text).not.toMatch(/userId|anonymousSessionId/);
  });
  it('uses one bounded Redis hash and stores no extra input properties', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(1),
      hGet: jest.fn().mockResolvedValue(null),
      hmGet: jest.fn(),
    };
    const cache = new RedisPipelineCandidateCache(redis, () => 1000);
    const key = `mkt:cand:v2:${'a'.repeat(64)}`;
    await cache.set(
      key,
      [
        { id, score: 1, privateField: 'never store' } as {
          id: string;
          score: number;
        },
      ],
      120,
    );
    expect(redis.eval.mock.calls[0][1].keys).toEqual([
      'mkt:cand:v2:bounded',
      'mkt:cand:v2:bounded:expiry',
    ]);
    expect(redis.eval.mock.calls[0][1].arguments[1]).not.toContain(
      'privateField',
    );
    expect(redis.eval.mock.calls[0][0]).toContain('>=256');
    expect(redis.eval.mock.calls[0][0]).toContain('ZRANGEBYSCORE');
    expect(await cache.get(key)).toBeNull();
    redis.hGet.mockResolvedValue(
      JSON.stringify({
        expires: 2000,
        rows: [{ id, score: 1, privateField: 'reject' }],
      }),
    );
    expect(await cache.get(key)).toBeNull();
  });
  it('opens its circuit after repeated Redis failures without inventing data', async () => {
    let clock = 1000;
    const redis = {
      eval: jest.fn(),
      hGet: jest.fn().mockRejectedValue(new Error('provider failure')),
      hmGet: jest.fn(),
    };
    const cache = new RedisPipelineCandidateCache(redis, () => clock);
    const key = `mkt:cand:v2:${'b'.repeat(64)}`;
    for (let i = 0; i < 5; i++) await expect(cache.get(key)).rejects.toThrow();
    await expect(cache.get(key)).rejects.toThrow('Candidate cache unavailable');
    expect(redis.hGet).toHaveBeenCalledTimes(5);
    clock += 10000;
    redis.hGet.mockResolvedValue(null);
    expect(await cache.get(key)).toBeNull();
  });
  it('retains admission for timed-out Redis commands until the provider actually settles', async () => {
    const redis = {
      eval: jest.fn(),
      hGet: jest.fn(() => new Promise<string | null>(() => undefined)),
      hmGet: jest.fn(),
    };
    const cache = new RedisPipelineCandidateCache(redis);
    const key = `mkt:cand:v2:${'c'.repeat(64)}`;
    const first = await Promise.allSettled(
      Array.from({ length: 12 }, () => cache.get(key)),
    );
    expect(first.every((result) => result.status === 'rejected')).toBe(true);
    expect(redis.hGet).toHaveBeenCalledTimes(4);
    await expect(cache.get(key)).rejects.toThrow('Candidate cache busy');
    expect(redis.hGet).toHaveBeenCalledTimes(4);
  });
  it('reads every page key with one HMGET and validates each entry independently', async () => {
    const valid = JSON.stringify({ expires: 5000, rows: [{ id, score: 2 }] });
    const redis = {
      eval: jest.fn(),
      hGet: jest.fn(),
      hmGet: jest
        .fn()
        .mockResolvedValue([
          valid,
          null,
          '{"expires":5000,"rows":[{"id":"not-a-uuid","score":1}]}',
          JSON.stringify({ expires: 999, rows: [{ id, score: 1 }] }),
        ]),
    };
    const cache = new RedisPipelineCandidateCache(redis, () => 1000);
    const keys = ['d', 'e', 'f', '0'].map(
      (char) => `mkt:cand:v2:${char.repeat(64)}`,
    );
    const found = await cache.getMany([
      ...keys,
      keys[0],
      'mkt:cand:v2:not-a-key',
    ]);
    expect(redis.hmGet).toHaveBeenCalledTimes(1);
    expect(redis.hmGet.mock.calls[0][1]).toEqual(
      keys.map((key) => key.slice(-64)),
    );
    // Missing, malformed and expired entries are misses; only one valid hit.
    expect([...found.keys()]).toEqual([keys[0]]);
    expect(found.get(keys[0])).toEqual([{ id, score: 2 }]);
  });
  it('treats a short HMGET reply as a miss and refuses oversized batches', async () => {
    const redis = {
      eval: jest.fn(),
      hGet: jest.fn(),
      hmGet: jest.fn().mockResolvedValue([null]),
    };
    const cache = new RedisPipelineCandidateCache(redis, () => 1000);
    const keys = ['1', '2'].map((char) => `mkt:cand:v2:${char.repeat(64)}`);
    expect((await cache.getMany(keys)).size).toBe(0);
    await expect(
      cache.getMany(
        Array.from(
          { length: 49 },
          (_, n) => `mkt:cand:v2:${n.toString(16).padStart(64, '0')}`,
        ),
      ),
    ).rejects.toThrow('Candidate cache batch too large');
    expect(redis.hmGet).toHaveBeenCalledTimes(1);
  });
  it('keeps ranking diagnostics out of public items', () => {
    const item = {
      id,
      entityType: 'PRODUCT',
      position: 0,
      explore: true,
      samplingProbability: 0.25,
      repeatOf: 'fresh-drops',
    };
    const page = serializePipelinePage({
      generatedAt: '2026-11-21T12:00:00.000Z',
      epoch: null,
      metadata: { partial: false, cachePolicy: 'private-no-store' },
      sections: [
        {
          key: 'hot-right-now',
          template: 'TREND',
          items: [item],
          viewAll: {},
          metadata: {},
        } as unknown as PipelineSection,
      ],
    });
    expect(page.sections[0].items[0]).toEqual({
      id,
      entityType: 'PRODUCT',
      position: 0,
    });
    expect(item.repeatOf).toBe('fresh-drops');
  });
  it('derives exposure identities from server receipts only', () => {
    const receipt = createPipelineExposureReceipt(
      [
        {
          key: 'hot-right-now',
          template: 'TREND',
          items: [{ id, entityType: 'PRODUCT', position: 0 }],
        } as unknown as PipelineSection,
      ],
      { asOf: new Date('2026-11-21T13:00:00.000Z'), epoch: null },
    );
    expect(pipelineExposureKeys(receipt)).toEqual({
      keys: [`2026-11-21T12:00:00.000Z|hot-right-now|${id}`],
      expiresAt: Date.parse('2026-11-21T18:00:00.000Z'),
    });
    expect(() =>
      pipelineExposureKeys({ kind: 'market-pipeline-exposure-receipt' }),
    ).toThrow('Invalid exposure receipt');
  });
});
