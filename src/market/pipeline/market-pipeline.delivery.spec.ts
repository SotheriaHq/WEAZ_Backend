import {
  RedisPipelineCandidateCache,
  createPipelineExposureReceipt,
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
});
