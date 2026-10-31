import { buildRedisConnectionFromEnv } from './queue.config';

describe('shared Redis connection', () => {
  const retryAfter = (attempt: number) =>
    buildRedisConnectionFromEnv({
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    }).retryStrategy?.(attempt);

  it('keeps reconnecting after any number of failures', () => {
    for (const attempt of [1, 2, 25, 26, 100_000]) {
      expect(retryAfter(attempt)).toEqual(expect.any(Number));
    }
  });

  it('backs off, and never waits longer than five seconds', () => {
    expect(retryAfter(1)).toBe(200);
    expect(retryAfter(2)).toBe(400);
    expect(retryAfter(100_000)).toBe(5000);
  });

  it('applies to host-based configuration too', () => {
    const options = buildRedisConnectionFromEnv({ REDIS_HOST: '127.0.0.1' });
    expect(options.retryStrategy?.(1)).toBe(200);
  });
});
