const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const sdk = require('@aws-sdk/client-s3');
const root = path.resolve(__dirname, '..');
const gateway = 'https://wiez-sit-media-gateway.sotheria-hq.workers.dev';
const secret = 'test-only-gateway-secret-with-more-than-32-bytes';
async function runProbe(mode) {
  const { handleMediaRequest } = await import(pathToFileURL(path.join(root, 'infrastructure/media-gateway/worker.mjs')).href);
  const objects = new Map(); const written = []; let puts = 0; let stdout = '';
  const config = ['STORAGE_PROVIDER=R2', 'R2_BUCKET=wiez-sit-media', `R2_ACCOUNT_ID=${'a'.repeat(32)}`,
    'R2_ACCESS_KEY_ID=test-key', 'R2_SECRET_ACCESS_KEY=test-secret', `MEDIA_GATEWAY_BASE_URL=${gateway}`,
    `MEDIA_GATEWAY_SECRET=${secret}`, 'MEDIA_GATEWAY_ENVIRONMENT=sit'].join('\n');
  const environment = {
    MEDIA_GATEWAY_BASE_URL: gateway, MEDIA_GATEWAY_SECRET: secret, MEDIA_GATEWAY_ENVIRONMENT: 'sit',
    MEDIA_GATEWAY_ALLOWED_ORIGINS: require('../docs/storage/r2-sit-cors.json')[0].AllowedOrigins.join(','),
    MEDIA_BUCKET: {
      head: async (key) => objects.has(key) ? metadata(objects.get(key)) : null,
      get: async (key, options) => {
        if (!objects.has(key)) return null;
        const body = objects.get(key); const range = options?.range;
        return { ...metadata(body), body: new Response(range ? body.subarray(range.offset, range.offset + range.length) : body).body };
      },
    },
  };
  function metadata(body) { return { size: body.length, etag: 'fixture-etag', httpEtag: '"fixture-etag"',
    httpMetadata: { contentType: 'image/png' }, uploaded: new Date(0) }; }
  class FakeS3Client {
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof sdk.PutObjectCommand) {
        puts++; objects.set(Key, Buffer.from(Body));
        if (mode === 'uncertain-put') throw new Error('SDK_NETWORK_FAILURE');
        return {};
      }
      if (command instanceof sdk.DeleteObjectCommand) { objects.delete(Key); return {}; }
      if (command instanceof sdk.HeadObjectCommand) {
        if (!objects.has(Key)) throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
        return { ContentLength: objects.get(Key).length };
      }
      throw new Error('unexpected command');
    }
    destroy() {}
  }
  const fakeFs = { ...fs,
    readFileSync: (file, ...args) => path.basename(file) === '.env.r2.local' ? Buffer.from(config) : fs.readFileSync(file, ...args),
    mkdirSync() {}, writeFileSync: (_file, content) => written.push(content),
  };
  const module = { exports: {} }; const processStub = { stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } };
  const requireStub = (name) => {
    if (name === 'node:fs') return fakeFs;
    if (name === '@aws-sdk/client-s3') return { ...sdk, S3Client: FakeS3Client };
    if (name.startsWith('../docs/')) return require(path.join(__dirname, name));
    return require(name);
  };
  const execute = vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(path.join(__dirname, 'verify-r2-media-gateway.cjs'), 'utf8')}\n})`, {
    Buffer, URL, AbortSignal, process: processStub,
    fetch: async (url, options = {}) => {
      if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return new Response('<Code>InvalidArgument</Code>', { status: 400 });
      if (mode === 'starter') return new Response('Hello World');
      return handleMediaRequest(new Request(url, options), environment, { waitUntil() {} }, { cache: null });
    },
  });
  execute(requireStub, module, module.exports, __dirname);
  const report = await module.exports.main();
  assert.equal(stdout.includes(secret), false); assert.equal(stdout.includes('sig='), false);
  assert.equal(written.length, 1); assert.equal(objects.size, 0);
  return { report, puts, code: processStub.exitCode };
}
test('full gateway smoke passes against actual Worker and signer with isolated object fixtures', async () => {
  const { report, puts, code } = await runProbe('ready');
  assert.equal(code, 0, JSON.stringify(report)); assert.equal(report.cleanup, true); assert.equal(puts, 1);
  assert.equal(report.checks.length, 8);
});
test('starter Worker fails before object writes', async () => {
  const { report, puts, code } = await runProbe('starter');
  assert.equal(code, 1); assert.equal(puts, 0); assert.equal(report.failure.code, 'WORKER_NOT_READY'); assert.equal(report.cleanup, true);
});
test('uncertain PUT response still deletes and verifies the potentially committed object', async () => {
  const { report, puts, code } = await runProbe('uncertain-put');
  assert.equal(code, 1); assert.equal(puts, 1); assert.equal(report.cleanup, true); assert.equal(report.failure.phase, 'temporary-object');
});
