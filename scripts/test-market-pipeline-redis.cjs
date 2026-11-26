// Real Redis adapter proof. Only two keys in a random closed test namespace are
// written/deleted. Never FLUSH, production cache keys or remote endpoints.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const Redis = require('ioredis');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { emitDecoratorMetadata: false },
});
const {
  RedisPipelineCandidateCache,
} = require('../src/market/pipeline/market-pipeline.delivery');

async function main() {
  const endpoint = new URL(
    process.env.MARKET_INTELLIGENCE_REDIS_TEST_URL ||
      'redis://127.0.0.1:6379/0',
  );
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname),
    'Loopback Redis required',
  );
  assert(['redis:', 'rediss:'].includes(endpoint.protocol));
  const namespace = 'mkt:cand:v2:test:' + randomUUID().replaceAll('-', '');
  assert(/^mkt:cand:v2:test:[a-f0-9]{32}$/.test(namespace));
  const owned = [namespace + ':bounded', namespace + ':bounded:expiry'];
  const redis = new Redis({
    host: endpoint.hostname,
    port: Number(endpoint.port || 6379),
    db: Number(endpoint.pathname.slice(1) || 0),
    username: decodeURIComponent(endpoint.username) || undefined,
    password: decodeURIComponent(endpoint.password) || undefined,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
    enableOfflineQueue: false,
    lazyConnect: true,
    ...(endpoint.protocol === 'rediss:' ? { tls: {} } : {}),
  });
  redis.on('error', () => {});
  let now = Date.now(),
    calls = 0,
    checks = 0;
  const timed = async (work) => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      const elapsed = performance.now() - started;
      if (elapsed > 20)
        console.log(
          'OBSERVATION ' +
            Math.round(elapsed) +
            'ms Redis command; completedChecks=' +
            checks +
            '; dispatchedCommands=' +
            calls,
        );
    }
  };
  const adapter = {
    hGet: async (key, field) => {
      calls++;
      assert(owned.includes(key));
      return timed(() => redis.hget(key, field));
    },
    eval: async (script, { keys, arguments: args }) => {
      calls++;
      assert(keys.every((key) => owned.includes(key)));
      return timed(() => redis.eval(script, keys.length, ...keys, ...args));
    },
  };
  const cache = new RedisPipelineCandidateCache(adapter, () => now, namespace);
  const key = (seed) =>
    'mkt:cand:v2:' + createHash('sha256').update(String(seed)).digest('hex');
  const rows = [{ id: randomUUID(), score: 1.25 }];
  const check = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  try {
    await redis.connect();
    await redis.ping();
    await cache.set(key('first'), rows, 1);
    check(
      await cache.get(key('first')),
      rows,
      'IDs and finite scores round-trip through real Lua/hash',
    );
    for (const storage of owned) {
      const ttl = await redis.ttl(storage);
      assert(ttl > 0 && ttl <= 120, 'Both storage keys expire');
      checks++;
    }
    const raw = JSON.parse(await redis.hget(owned[0], key('first').slice(-64)));
    check(
      Object.keys(raw).sort(),
      ['expires', 'rows'],
      'Cache envelope contains no actor profile',
    );
    check(
      Object.keys(raw.rows[0]).sort(),
      ['id', 'score'],
      'Cache payload contains IDs and scores only',
    );
    for (let index = 1; index < 256; index++)
      await cache.set(key(index), rows, 1);
    check(
      await redis.hlen(owned[0]),
      256,
      'Actual hash admission is bounded to256fields',
    );
    check(
      await redis.zcard(owned[1]),
      256,
      'Expiry index matches bounded hash',
    );
    await cache.set(key('overflow'), rows, 1);
    check(
      await cache.get(key('overflow')),
      null,
      'Capacity cannot grow with arbitrary filter keys',
    );
    check(
      await redis.hlen(owned[0]),
      256,
      'Overflow leaves capacity unchanged',
    );
    now += 1001;
    check(
      await cache.get(key('first')),
      null,
      'Expired entry is not returned before physical cleanup',
    );
    await cache.set(key('replacement'), rows, 120);
    check(
      await redis.hlen(owned[0]),
      1,
      'Next admission reclaims expired fields atomically',
    );
    check(
      await redis.zcard(owned[1]),
      1,
      'Expiry index reclaims same expired fields',
    );
    check(
      await cache.get(key('replacement')),
      rows,
      'Cache capacity recovers after expirations',
    );

    const field = key('malformed').slice(-64);
    for (const value of [
      'not-json',
      JSON.stringify({
        expires: now + 10000,
        rows: [
          {
            id: rows[0].id,
            score: 1,
            email: 'must-never-return@fixture.invalid',
          },
        ],
      }),
      JSON.stringify({
        expires: now + 10000,
        rows: [{ id: 'invalid', score: 1 }],
      }),
      'x'.repeat(40001),
    ]) {
      await redis.hset(owned[0], field, value);
      check(
        await cache.get(key('malformed')),
        null,
        'Malformed/oversized/private payload fails closed',
      );
    }
    const beforeInvalid = calls;
    check(
      await cache.get('unsafe'),
      null,
      'Invalid logical cache key rejected',
    );
    check(calls, beforeInvalid, 'Invalid key performs no provider work');

    // Real provider failures, confined to this disposable hash: Redis WRONGTYPE
    // drives the production circuit; no daemon pause or DEBUG SLEEP is used.
    await redis.del(owned[0]);
    await redis.set(owned[0], 'wrong-type');
    for (let index = 0; index < 5; index++) {
      await assert.rejects(cache.get(key('replacement')), (error) =>
        error.message.includes('WRONGTYPE'),
      );
      checks++;
    }
    const atOpen = calls;
    await assert.rejects(cache.get(key('replacement')), /unavailable/);
    checks++;
    check(calls, atOpen, 'Open circuit issues no further provider commands');
    now += 10001;
    await redis.del(...owned);
    await cache.set(key('recovered'), rows, 120);
    check(
      await cache.get(key('recovered')),
      rows,
      'Circuit recovers against actual Redis after cooldown',
    );
    console.log(
      `PASS ${checks} isolated actual Redis pipeline cache/admission/expiry/failure proofs`,
    );
  } finally {
    if (redis.status === 'ready') {
      assert(owned.every((storage) => storage.startsWith(namespace + ':')));
      await redis.unlink(...owned);
      check(await redis.exists(...owned), 0, 'Owned keys removed');
      console.log('CLEANUP PASS random test hash and expiry index removed');
    }
    redis.disconnect();
  }
}
main().catch((error) => {
  console.error(
    error.code || error.name,
    error.message.replace(/rediss?:\/\/\S+/g, '[redacted]'),
  );
  process.exitCode = 1;
});
