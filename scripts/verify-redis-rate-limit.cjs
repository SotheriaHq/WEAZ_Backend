// Runs the production rate-limit storage against real Redis, including an outage.
// Point REDIS_URL at a disposable database: this script only touches its own keys.
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { getStorageToken } = require('@nestjs/throttler');
const {
  RedisThrottlerStorage,
} = require('../src/auth/guard/redis-throttler.storage');
const { RateLimitingModule } = require('../src/auth/rate-limiting.module');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/15';
const target = new URL(REDIS_URL);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storageFor = (url) =>
  new RedisThrottlerStorage(new ConfigService({ REDIS_URL: url }));

// A TCP hop in front of Redis, so one test can cut the connection and restore it.
function createProxy() {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(
      Number(target.port || 6379),
      target.hostname,
    );
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(upstream).pipe(client);
  });
  return {
    listen: (port = 0) =>
      new Promise((resolve) =>
        server.listen(port, '127.0.0.1', () => resolve(server.address().port)),
      ),
    cut: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function main() {
  const inspector = new Redis(REDIS_URL);
  const storages = [storageFor(REDIS_URL), storageFor(REDIS_URL)];
  const [replicaA, replicaB] = storages;
  const name = () => `verify-${randomUUID()}`;

  const startup = name();
  const first = await Promise.all(
    Array.from({ length: 50 }, () =>
      replicaA.increment(startup, 60_000, 100, 60_000, 'default'),
    ),
  );
  assert.equal(
    first.filter((record) => !record.isBlocked).length,
    50,
    'concurrent first requests share one connection',
  );

  const shared = name();
  const burst = await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      storages[index % 2].increment(shared, 60_000, 50, 60_000, 'default'),
    ),
  );
  assert.equal(
    burst.filter((record) => !record.isBlocked).length,
    50,
    'two replicas admit exactly the limit between them',
  );

  const isolated = name();
  const firstScope = await replicaA.increment(isolated, 60_000, 1, 60_000, 'a');
  const otherScope = await replicaA.increment(isolated, 60_000, 1, 60_000, 'b');
  const otherKey = await replicaA.increment(name(), 60_000, 1, 60_000, 'a');
  assert.deepEqual(
    [firstScope, otherScope, otherKey].map((record) => record.totalHits),
    [1, 1, 1],
    'keys and throttler names do not share a counter',
  );

  const blocked = name();
  await replicaA.increment(blocked, 300, 1, 1500, 'default');
  const tripped = await replicaB.increment(blocked, 300, 1, 1500, 'default');
  assert.equal(tripped.isBlocked, true, 'over the limit is blocked');
  await sleep(700);
  const retried = await replicaA.increment(blocked, 300, 1, 1500, 'default');
  assert.equal(retried.isBlocked, true, 'a block outlives the window');
  assert.ok(
    retried.timeToBlockExpire <= tripped.timeToBlockExpire,
    'retrying while blocked never extends the block',
  );
  await sleep(1000);
  const released = await replicaB.increment(blocked, 300, 1, 1500, 'default');
  assert.deepEqual(
    [released.isBlocked, released.totalHits],
    [false, 1],
    'a finished block starts a fresh window',
  );

  const windowed = name();
  await replicaA.increment(windowed, 200, 5, 200, 'default');
  await replicaA.increment(windowed, 200, 5, 200, 'default');
  await sleep(350);
  const reset = await replicaA.increment(windowed, 200, 5, 200, 'default');
  assert.equal(reset.totalHits, 1, 'an expired window resets the count');

  const identifying = `ip:203.0.113.77:${randomUUID()}`;
  await replicaA.increment(identifying, 60_000, 5, 60_000, 'default');
  const keys = await inspector.keys('wiez:throttle:v1:*');
  assert.ok(keys.length > 0, 'keys use the versioned namespace');
  assert.ok(
    keys.every((key) => /^wiez:throttle:v1:[a-f0-9]{64}$/.test(key)),
    'no address or account id is readable in Redis',
  );
  const ttls = await Promise.all(keys.map((key) => inspector.pttl(key)));
  assert.ok(
    ttls.every((ttl) => ttl > 0),
    'every key expires by itself',
  );

  const proxy = createProxy();
  const port = await proxy.listen();
  const proxied = new URL(REDIS_URL);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);
  const outage = storageFor(proxied.href);
  const key = name();
  await outage.increment(key, 60_000, 100, 60_000, 'default');
  await proxy.cut();
  const started = Date.now();
  await assert.rejects(
    outage.increment(key, 60_000, 100, 60_000, 'default'),
    (error) => {
      assert.equal(error.getStatus(), 503, 'an outage fails closed');
      assert.equal(error.message, 'Service temporarily unavailable');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2500, 'an outage fails fast');
  const restored = createProxy();
  await restored.listen(port);
  let recovered = null;
  for (let attempt = 0; attempt < 60 && !recovered; attempt += 1) {
    await sleep(200);
    recovered = await outage
      .increment(key, 60_000, 100, 60_000, 'default')
      .catch(() => null);
  }
  assert.equal(recovered?.totalHits, 2, 'it recovers with its count intact');
  outage.onModuleDestroy();
  await assert.rejects(
    outage.increment(key, 60_000, 100, 60_000, 'default'),
    /Service temporarily unavailable/,
    'a closed storage refuses work',
  );
  await restored.cut();

  // Nest must own the store's lifecycle, or shutdown leaves a socket open.
  process.env.REDIS_URL = REDIS_URL;
  const app = await NestFactory.createApplicationContext(RateLimitingModule, {
    logger: false,
  });
  const managed = app.get(getStorageToken(), { strict: false });
  await managed.increment(name(), 60_000, 5, 60_000, 'default');
  await app.close();
  await assert.rejects(
    managed.increment(name(), 60_000, 5, 60_000, 'default'),
    /Service temporarily unavailable/,
    'closing the application closes the store',
  );

  const leftovers = await inspector.keys('wiez:throttle:v1:*');
  await Promise.all(leftovers.map((entry) => inspector.del(entry)));
  for (const storage of storages) storage.onModuleDestroy();
  inspector.disconnect();
  console.log('Redis rate limiting verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
