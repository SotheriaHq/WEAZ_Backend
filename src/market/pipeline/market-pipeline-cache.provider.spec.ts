import { getQueueToken } from '@nestjs/bullmq';
import { SEARCH_QUEUE } from '../../queue/queue.constants';
import {
  createMarketPipelineCache,
  marketPipelineCacheProvider,
} from './market-pipeline-cache.provider';
import { MARKET_PIPELINE_CACHE } from './market-pipeline.service';

jest.mock('./market-pipeline.service', () => ({
  MARKET_PIPELINE_CACHE: Symbol('test-cache'),
}));

describe('Market shared Redis cache provider', () => {
  const id = '00000000-0000-0000-0000-000000000001',
    key = 'mkt:cand:v2:' + 'a'.repeat(64);
  it('registers the existing queue token under the pipeline cache token', () => {
    expect(marketPipelineCacheProvider.provide).toBe(MARKET_PIPELINE_CACHE);
    expect(marketPipelineCacheProvider.inject).toEqual([
      getQueueToken(SEARCH_QUEUE),
    ]);
    expect(marketPipelineCacheProvider.useFactory).toBe(
      createMarketPipelineCache,
    );
  });
  it('adapts HGET and EVAL using the same existing resolved client', async () => {
    const redis = {
      hget: jest.fn().mockResolvedValue(
        JSON.stringify({
          expires: Date.now() + 10000,
          rows: [{ id, score: 1 }],
        }),
      ),
      eval: jest.fn().mockResolvedValue(1),
    };
    const existing = Promise.resolve(redis);
    const queue = { client: existing } as unknown as Parameters<
      typeof createMarketPipelineCache
    >[0];
    const cache = createMarketPipelineCache(queue);
    await expect(cache.get(key)).resolves.toEqual([{ id, score: 1 }]);
    await expect(
      cache.set(key, [{ id, score: 1 }], 60),
    ).resolves.toBeUndefined();
    expect(redis.hget).toHaveBeenCalledWith(
      'mkt:cand:v2:bounded',
      'a'.repeat(64),
    );
    const [script, keyCount, hash, expiry, field] = redis.eval.mock.calls[0];
    expect(script).toContain("redis.call('HSET'");
    expect(keyCount).toBe(2);
    expect([hash, expiry, field]).toEqual([
      'mkt:cand:v2:bounded',
      'mkt:cand:v2:bounded:expiry',
      'a'.repeat(64),
    ]);
    expect(queue.client).toBe(existing);
  });
  it('rejects provider failures so the composer can use its normal cache-miss path', async () => {
    const redis = {
      hget: jest.fn().mockRejectedValue(new Error('offline')),
      eval: jest.fn(),
    };
    const cache = createMarketPipelineCache({
      client: Promise.resolve(redis),
    } as unknown as Parameters<typeof createMarketPipelineCache>[0]);
    await expect(cache.get(key)).rejects.toThrow('offline');
  });
});
