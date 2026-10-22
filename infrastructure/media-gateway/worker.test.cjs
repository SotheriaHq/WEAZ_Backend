const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const ts = require('typescript');

const configFile = path.resolve(__dirname, '../../src/upload/storage-provider.config.ts');
const configModule = new Module(configFile, module);
configModule.paths = Module._nodeModulePaths(path.dirname(configFile));
configModule._compile(ts.transpileModule(fs.readFileSync(configFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, configFile);
const { signPublicGatewayUrl } = configModule.exports;
const worker = import(pathToFileURL(path.join(__dirname, 'worker.mjs')).href);
const NOW = 1_800_000_000_000;
const SECRET = 'local-only-gateway-test-secret-at-least-32-bytes';
const KEY = 'POST_IMAGE/user/Adiré 100%.webp';
const gateway = { baseUrl: 'https://media.example.test/media', secret: SECRET, environment: 'sit', ttlSeconds: 300 };

function fixture(options = {}) {
  const bytes = Buffer.from('0123456789');
  const calls = { head: 0, get: 0, cacheMatch: 0, cachePut: 0, keys: [], putUrls: [] };
  const pending = [];
  const entries = new Map();
  const metadata = () => ({
    key: KEY, size: bytes.length, etag: 'v1', httpEtag: '"v1"', uploaded: new Date('2026-10-20T10:00:00Z'),
    httpMetadata: { contentType: options.contentType ?? 'image/webp' },
    writeHttpMetadata(headers) { headers.set('Content-Type', this.httpMetadata.contentType); },
  });
  const env = {
    MEDIA_GATEWAY_BASE_URL: gateway.baseUrl, MEDIA_GATEWAY_SECRET: SECRET, MEDIA_GATEWAY_ENVIRONMENT: 'sit',
    ...options.env,
    MEDIA_BUCKET: {
      async head(key) {
        calls.head++; calls.keys.push(key);
        if (options.storageFailure) throw new Error('private service details');
        return options.notFound ? null : metadata();
      },
      async get(key, getOptions) {
        calls.get++; calls.keys.push(key);
        if (options.storageFailure) throw new Error('private service details');
        if (options.notFound) return null;
        if (options.changedBetweenHeadAndGet && getOptions?.onlyIf) return { ...metadata(), etag: 'v2' };
        const range = getOptions?.range;
        return { ...metadata(), body: range ? bytes.subarray(range.offset, range.offset + range.length) : bytes };
      },
    },
  };
  const cache = {
    async match(request) { calls.cacheMatch++; return entries.get(request.url)?.clone(); },
    async put(request, response) { calls.cachePut++; calls.putUrls.push(request.url); entries.set(request.url, response.clone()); },
  };
  return {
    env, calls, cache, pending,
    async run({ url = signPublicGatewayUrl(gateway, KEY, 'GET', NOW), method = 'GET', headers = {}, nowMs = NOW } = {}) {
      const { handleMediaRequest } = await worker;
      const response = await handleMediaRequest(new Request(url, { method, headers }), env, { waitUntil: (promise) => pending.push(promise) }, { cache, nowMs });
      await Promise.all(pending.splice(0));
      return response;
    },
  };
}

test('Node API signer and Worker agree on UTF-8, escaped names, audience and route prefix', async () => {
  const f = fixture();
  const response = await f.run();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
  assert.deepEqual(f.calls.keys, [KEY]);
  assert.equal(response.headers.get('etag'), '"v1"');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert(!f.calls.putUrls[0].includes('sig='));
});

test('invalid/expired requests never reach even a warm edge cache', async () => {
  const f = fixture();
  await f.run();
  const base = signPublicGatewayUrl(gateway, KEY, 'GET', NOW);
  const changes = [
    (url) => url.searchParams.set('sig', 'a'.repeat(43)),
    (url) => url.searchParams.set('env', 'production'),
    (url) => url.searchParams.set('exp', '1800000901'),
    (url) => url.searchParams.set('method', 'HEAD'),
    (url) => url.searchParams.append('env', 'sit'),
    (url) => url.searchParams.set('extra', 'ignored'),
    (url) => { url.hostname = 'other.example.test'; },
    (url) => { url.pathname = url.pathname.replace('POST_IMAGE', 'BRAND_VERIFICATION'); },
  ];
  for (const mutate of changes) {
    const url = new URL(base); mutate(url);
    const before = f.calls.cacheMatch;
    assert.equal((await f.run({ url: url.href })).status, 403);
    assert.equal(f.calls.cacheMatch, before);
  }
  const before = f.calls.cacheMatch;
  assert.equal((await f.run({ nowMs: NOW + 300_000 })).status, 403);
  assert.equal((await f.run({ url: gateway.baseUrl + '/' + KEY })).status, 403);
  assert.equal(f.calls.cacheMatch, before);
  assert.equal(f.calls.get, 1);
});

test('HEAD is a safe subset of GET, while a HEAD token cannot fetch the body', async () => {
  const f = fixture();
  const response = await f.run({ method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), '10');
  assert.equal(f.calls.get, 0);
  const headUrl = signPublicGatewayUrl(gateway, KEY, 'HEAD', NOW);
  assert.equal((await f.run({ url: headUrl })).status, 403);
  assert.equal((await f.run({ url: headUrl, method: 'HEAD' })).status, 200);
});

test('token bounds and independently deployed secrets/environments are enforced', async () => {
  const f = fixture({ env: { MEDIA_GATEWAY_MAX_TTL_SECONDS: '300' } });
  const tooLong = signPublicGatewayUrl({ ...gateway, ttlSeconds: 900 }, KEY, 'GET', NOW);
  assert.equal((await f.run({ url: tooLong })).status, 403);
  const wrongEnvironment = signPublicGatewayUrl({ ...gateway, environment: 'production' }, KEY, 'GET', NOW);
  const wrongSecret = signPublicGatewayUrl({ ...gateway, secret: SECRET + '-different' }, KEY, 'GET', NOW);
  assert.equal((await f.run({ url: wrongEnvironment })).status, 403);
  assert.equal((await f.run({ url: wrongSecret })).status, 403);
  assert.equal(f.calls.cacheMatch, 0);
});

test('canonical paths prevent encoded path aliases and ambiguous query claims', async () => {
  const f = fixture();
  const url = signPublicGatewayUrl(gateway, 'folder/nested/file.webp', 'GET', NOW);
  assert.equal((await f.run({ url: url.replace('/nested/', '%2Fnested/') })).status, 403);
  assert.equal((await f.run({ url: url.replace('/file.webp', '/%2E%2E/file.webp') })).status, 403);
  assert.equal((await f.run({ url: url.replace('method=GET', 'method=GET&method=GET') })).status, 403);
  assert.equal(f.calls.cacheMatch, 0);
});

test('explicit CORS origins are reapplied per response, including cache hits', async () => {
  const f = fixture({ env: { MEDIA_GATEWAY_ALLOWED_ORIGINS: 'https://web.example.test,https://admin.example.test' } });
  const web = await f.run({ headers: { Origin: 'https://web.example.test' } });
  const admin = await f.run({ headers: { Origin: 'https://admin.example.test' } });
  assert.equal(web.headers.get('access-control-allow-origin'), 'https://web.example.test');
  assert.equal(admin.headers.get('access-control-allow-origin'), 'https://admin.example.test');
  assert.equal(admin.headers.get('vary'), 'Origin');
  assert.equal(f.calls.get, 1);
  assert.equal((await f.run({ headers: { Origin: 'https://attacker.example.test' } })).status, 403);
});

test('read-only preflight requires a valid token and approved headers', async () => {
  const f = fixture();
  const response = await f.run({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Range, If-None-Match' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-headers'), 'range, if-none-match');
  assert.equal((await f.run({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PUT' } })).status, 403);
  assert.equal((await f.run({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } })).status, 403);
  assert.equal((await f.run({ method: 'POST' })).status, 405);
  assert.equal(f.calls.head + f.calls.get + f.calls.cacheMatch, 0);
});

test('single byte ranges stream correct offsets and report full object size', async () => {
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=0-99', '0123456789', 'bytes 0-9/10'],
  ]) {
    const f = fixture();
    const response = await f.run({ headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), expected);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(response.headers.get('content-length'), String(expected.length));
    assert.equal(f.calls.cachePut, 0);
  }
});

test('invalid, multiple, unsatisfiable and oversized byte ranges are bounded', async () => {
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=20-30', 'bytes=5-3', 'bytes=0-1,3-4', 'bytes=99999999999999999999999999-']) {
    const f = fixture();
    const response = await f.run({ headers: { Range: range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(f.calls.get, 0);
  }
});

test('If-Range mismatch returns the full object and HEAD ignores Range', async () => {
  const f = fixture();
  const response = await f.run({ headers: { Range: 'bytes=2-5', 'If-Range': '"old"' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
  const head = await f.run({ method: 'HEAD', headers: { Range: 'bytes=2-5' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

test('range metadata changes cannot produce incorrectly sized responses', async () => {
  const f = fixture({ changedBetweenHeadAndGet: true });
  assert.equal((await f.run({ headers: { Range: 'bytes=2-5' } })).status, 412);
});

test('ETag, weak validators and modification dates honor HTTP preconditions', async () => {
  for (const headers of [{ 'If-None-Match': '"v1"' }, { 'If-None-Match': 'W/"v1"' }, { 'If-None-Match': '"old", "v1"' }, { 'If-Modified-Since': 'Tue, 20 Oct 2026 12:00:00 GMT' }]) {
    const f = fixture();
    const response = await f.run({ headers });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(f.calls.get, 0);
  }
  for (const headers of [{ 'If-Match': '"old"' }, { 'If-Match': 'W/"v1"' }, { 'If-Unmodified-Since': 'Tue, 20 Oct 2026 09:00:00 GMT' }]) {
    assert.equal((await fixture().run({ headers })).status, 412);
  }
  const f = fixture(); await f.run();
  assert.equal((await f.run({ headers: { 'If-None-Match': '"v1"' } })).status, 304);
  assert.equal(f.calls.head, 0);
  assert.equal(f.calls.get, 1);
});

test('missing, unavailable or non-media objects never expose internal responses', async () => {
  assert.equal((await fixture({ notFound: true }).run()).status, 404);
  const unavailable = await fixture({ storageFailure: true }).run();
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), '');
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.equal((await fixture({ contentType: 'text/html' }).run()).status, 415);
});

test('invalid gateway secrets, TTLs and raw storage routes fail closed', async () => {
  for (const env of [
    { MEDIA_GATEWAY_SECRET: 'short' }, { MEDIA_GATEWAY_MAX_TTL_SECONDS: '901' },
    { MEDIA_GATEWAY_BASE_URL: 'https://pub-test.r2.dev' }, { MEDIA_GATEWAY_ENVIRONMENT: 'bad\nvalue' },
  ]) {
    const f = fixture({ env });
    assert.equal((await f.run()).status, 503);
    assert.equal(f.calls.cacheMatch + f.calls.head + f.calls.get, 0);
  }
});
