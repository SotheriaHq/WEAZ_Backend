/* Disposable SIT gateway probe. Never starts the app, deploys, or changes active.env. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { parse } = require('dotenv');
const ts = require('typescript');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const EXPECTED_GATEWAY = 'https://wiez-sit-media-gateway.sotheria-hq.workers.dev';

function storageHelpers() {
  const filename = path.join(__dirname, '../src/upload/storage-provider.config.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(compiled, filename);
  return loaded.exports;
}

async function main() {
  const report = { time: new Date().toISOString(), gateway: EXPECTED_GATEWAY, checks: [], cleanup: false,
    privateApiAuthorization: 'Not exercised: requires deployed API identities and private parent fixtures.',
    cacheObservation: 'Warm-path authorization tested; internal edge cache hit is not externally observable.' };
  const objectKey = `__wiez_gateway_smoke/${randomUUID()}/pixel.png`;
  let client; let attemptedObject = false; let phase = 'configuration';
  const pass = (name) => report.checks.push(name);
  const ensure = (condition, code) => { if (!condition) throw new Error(code); };
  const request = async (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  try {
    const local = parse(fs.readFileSync(path.join(__dirname, '../.env.r2.local')));
    const { resolveStorageProviderSettings, signPublicGatewayUrl, storageObjectUrl } = storageHelpers();
    const settings = resolveStorageProviderSettings({ get: (name) => local[name] });
    ensure(settings.provider === 'R2' && settings.bucket === 'wiez-sit-media', 'INVALID_SIT_PROVIDER');
    ensure(settings.publicGateway?.baseUrl === EXPECTED_GATEWAY && settings.publicGateway?.environment === 'sit', 'GATEWAY_NOT_CONFIGURED');
    const gateway = settings.publicGateway;
    // Check deployed authorization before creating even a disposable object.
    phase = 'worker-readiness';
    ensure((await request(`${gateway.baseUrl}/__wiez_gateway_smoke/readiness.png`)).status === 403, 'WORKER_NOT_READY');
    pass('unsigned-worker-request-denied');
    client = new S3Client({ region: settings.region, endpoint: settings.endpoint, forcePathStyle: settings.forcePathStyle,
      credentials: settings.credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, socketTimeout: 30_000 }), maxAttempts: 2 });
    const body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII=', 'base64');
    phase = 'temporary-object';
    attemptedObject = true;
    await client.send(new PutObjectCommand({ Bucket: settings.bucket, Key: objectKey, Body: body, ContentType: 'image/png' }));
    const capability = signPublicGatewayUrl(gateway, objectKey);
    phase = 'signed-get';
    const full = await request(capability);
    ensure(full.status === 200 && Buffer.from(await full.arrayBuffer()).equals(body), 'SIGNED_BODY_MISMATCH');
    ensure(full.headers.get('content-type') === 'image/png', 'CONTENT_TYPE_MISMATCH');
    const etag = full.headers.get('etag'); ensure(Boolean(etag), 'MISSING_ETAG'); pass('signed-get-content-etag');
    phase = 'head';
    const head = await request(capability, { method: 'HEAD' });
    ensure(head.status === 200 && Number(head.headers.get('content-length')) === body.length && head.headers.get('etag') === etag &&
      (await head.arrayBuffer()).byteLength === 0, 'HEAD_MISMATCH'); pass('head');
    phase = 'range';
    const range = await request(capability, { headers: { Range: 'bytes=0-7', 'If-Match': etag } });
    ensure(range.status === 206 && range.headers.get('content-range') === `bytes 0-7/${body.length}` &&
      Buffer.from(await range.arrayBuffer()).equals(body.subarray(0, 8)), 'RANGE_MISMATCH'); pass('conditional-range');
    phase = 'etag-condition';
    ensure((await request(capability, { headers: { 'If-None-Match': etag } })).status === 304, 'ETAG_304_MISMATCH');
    ensure((await request(capability, { headers: { 'If-Match': '"unrelated"' } })).status === 412, 'ETAG_412_MISMATCH'); pass('etag-conditions');
    phase = 'warm-path-authorization';
    ensure((await request(capability)).status === 200, 'REPEAT_GET_FAILED');
    const unsigned = new URL(capability); unsigned.search = '';
    const tampered = new URL(capability); const sig = tampered.searchParams.get('sig');
    tampered.searchParams.set('sig', `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`);
    const wrongEnvironment = new URL(capability); wrongEnvironment.searchParams.set('env', 'production');
    const expired = signPublicGatewayUrl({ ...gateway, ttlSeconds: 60 }, objectKey, 'GET', Date.now() - 120_000);
    const tooFar = signPublicGatewayUrl({ ...gateway, ttlSeconds: 900 }, objectKey, 'GET', Date.now() + 60_000);
    const headOnly = signPublicGatewayUrl(gateway, objectKey, 'HEAD');
    for (const invalid of [unsigned.href, tampered.href, wrongEnvironment.href, expired, tooFar, headOnly]) {
      ensure((await request(invalid)).status === 403, 'INVALID_CAPABILITY_NOT_DENIED');
    }
    ensure((await request(headOnly, { method: 'HEAD' })).status === 200, 'HEAD_CAPABILITY_FAILED'); pass('warm-path-invalid-expired-environment-and-method-denial');
    phase = 'cors';
    const origins = require('../docs/storage/r2-sit-cors.json')[0].AllowedOrigins;
    for (const origin of origins) {
      const preflight = await request(capability, { method: 'OPTIONS', headers: { Origin: origin,
        'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range,if-none-match' } });
      ensure(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === origin, 'ALLOWED_CORS_FAILED');
      const corsRead = await request(capability, { method: 'HEAD', headers: { Origin: origin } });
      ensure(corsRead.status === 200 && corsRead.headers.get('access-control-allow-origin') === origin, 'CORS_READ_FAILED');
    }
    ensure((await request(capability, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid',
      'Access-Control-Request-Method': 'GET' } })).status === 403, 'UNTRUSTED_CORS_NOT_DENIED');
    pass('approved-cors-origins-and-untrusted-denial');
    phase = 'private-origin';
    const anonymous = await request(storageObjectUrl(settings, objectKey));
    let missingAuthorization = false;
    if (anonymous.status === 400) missingAuthorization = /<Code>InvalidArgument<\/Code>/.test(await anonymous.text());
    ensure([401, 403, 404].includes(anonymous.status) || missingAuthorization, 'UNSIGNED_PRIVATE_OBJECT_READABLE');
    pass('unsigned-r2-api-object-denied');
  } catch (error) {
    report.failure = { phase, code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PROBE_FAILED',
      httpStatus: error?.$metadata?.httpStatusCode ?? null };
  } finally {
    if (client && attemptedObject) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: 'wiez-sit-media', Key: objectKey }));
        try { await client.send(new HeadObjectCommand({ Bucket: 'wiez-sit-media', Key: objectKey })); throw new Error('OBJECT_REMAINS'); }
        catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; }
        report.cleanup = true;
      } catch { report.cleanupFailure = 'TEMPORARY_OBJECT_CLEANUP_FAILED'; }
    } else if (!attemptedObject) report.cleanup = true;
    client?.destroy();
    const directory = path.join(__dirname, '../docs/storage/evidence'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'r2-sit-gateway-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.failure || !report.cleanup ? 1 : 0;
  }
  return report;
}
module.exports = { storageHelpers, main };
if (require.main === module) main().catch(() => { process.stderr.write('Gateway probe could not complete; secret details omitted.\n'); process.exitCode = 1; });
