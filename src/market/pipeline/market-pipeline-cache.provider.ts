import { FactoryProvider } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SEARCH_QUEUE } from '../../queue/queue.constants';
import { PipelineCandidateCache } from './market-pipeline.cache';
import { RedisPipelineCandidateCache } from './market-pipeline.delivery';
import { MARKET_PIPELINE_CACHE } from './market-pipeline.service';

/** Reuse the existing API queue connection. No extra Redis client, background
 * connection loop or unbounded offline command queue is introduced here. */
export function createMarketPipelineCache(
  queue: Pick<Queue, 'client'>,
): PipelineCandidateCache {
  return new RedisPipelineCandidateCache({
    hGet: async (key, field) => (await queue.client).hget(key, field),
    hmGet: async (key, fields) => (await queue.client).hmget(key, ...fields),
    eval: async (script, { keys, arguments: args }) =>
      (await queue.client).eval(script, keys.length, ...keys, ...args),
  });
}

export const marketPipelineCacheProvider: FactoryProvider<PipelineCandidateCache> =
  {
    provide: MARKET_PIPELINE_CACHE,
    inject: [getQueueToken(SEARCH_QUEUE)],
    useFactory: createMarketPipelineCache,
  };
