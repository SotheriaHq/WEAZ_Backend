/* Storage-only probe. This never starts the app or changes its active environment. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parse } = require('dotenv');
const {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand,
  CopyObjectCommand, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

async function main() {
  const report = { time: new Date().toISOString(), bucket: 'wiez-sit-media', checks: [], cleanup: false };
  let client;
  let phase = 'configuration';
  const prefix = `__wiez_storage_smoke/${randomUUID()}`;
  const keys = ['source.txt', 'copy.txt', 'stale-copy.txt', 'signed-put.txt'].map((name) => `${prefix}/${name}`);
  const pass = (name) => report.checks.push(name);
  try {
    const config = parse(fs.readFileSync(path.join(__dirname, '../.env.r2.local')));
    if (config.STORAGE_PROVIDER !== 'R2' || config.R2_BUCKET !== report.bucket) throw new Error('INVALID_TEST_CONFIGURATION');
    if (!config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) throw new Error('MISSING_R2_CREDENTIALS');
    const endpoint = new URL(config.R2_ENDPOINT || `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname) ||
      endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('INVALID_R2_ENDPOINT_ORIGIN');
    client = new S3Client({ region: 'auto', endpoint: endpoint.origin, forcePathStyle: true,
      credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, socketTimeout: 30_000 }),
      maxAttempts: 2,
    });
    const bucket = report.bucket;
    const body = Buffer.from(`WIEZ private R2 test ${prefix}`);
    phase = 'put';
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: keys[0], Body: body, ContentType: 'text/plain' }));
    pass('put');
    phase = 'head';
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keys[0] }));
    if (head.ContentLength !== body.length || !head.ETag) throw new Error('HEAD_METADATA_MISMATCH');
    pass('head');
    phase = 'range-read';
    const ranged = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keys[0], Range: 'bytes=0-15', IfMatch: head.ETag }));
    if (!Buffer.from(await ranged.Body.transformToByteArray()).equals(body.subarray(0, 16))) throw new Error('RANGE_READ_MISMATCH');
    pass('range-read');
    phase = 'conditional-copy';
    const source = `${bucket}/${keys[0]}`;
    await client.send(new CopyObjectCommand({ Bucket: bucket, Key: keys[1], CopySource: source, CopySourceIfMatch: head.ETag }));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: keys[0], Body: Buffer.from('replacement source'), ContentType: 'text/plain' }));
    let rejected = false;
    try { await client.send(new CopyObjectCommand({ Bucket: bucket, Key: keys[2], CopySource: source, CopySourceIfMatch: head.ETag })); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 412) rejected = true; else throw error; }
    if (!rejected) throw new Error('STALE_COPY_WAS_NOT_REJECTED');
    const copied = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keys[1] }));
    if (!Buffer.from(await copied.Body.transformToByteArray()).equals(body)) throw new Error('IMMUTABLE_COPY_MISMATCH');
    pass('conditional-copy-and-immutable-result');
    phase = 'signed-put';
    const headers = { 'Content-Type': 'text/plain', 'Cache-Control': 'private, max-age=0, no-store' };
    const signedPut = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: keys[3], ContentType: headers['Content-Type'], CacheControl: headers['Cache-Control'] }),
      { expiresIn: 60, signableHeaders: new Set(['content-type']) });
    const uploaded = await fetch(signedPut, { method: 'PUT', headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!uploaded.ok) { report.httpStatus = uploaded.status; throw new Error('SIGNED_PUT_REJECTED'); }
    pass('signed-put');
    phase = 'signed-get';
    const signedGet = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: keys[3] }), { expiresIn: 60 });
    const downloaded = await fetch(signedGet, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(body)) throw new Error('SIGNED_GET_MISMATCH');
    pass('signed-get');
    phase = 'private-access';
    const anonymous = await fetch(`${endpoint.origin}/${bucket}/${keys[3]}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    let missingAuthorization = false;
    if (anonymous.status === 400) {
      const errorBody = await anonymous.text();
      missingAuthorization = /<Code>InvalidArgument<\/Code>/.test(errorBody) && /authorization/i.test(errorBody);
    }
    if (![401, 403, 404].includes(anonymous.status) && !missingAuthorization) { report.httpStatus = anonymous.status; throw new Error('UNEXPECTED_ANONYMOUS_ACCESS'); }
    report.anonymousApiStatus = anonymous.status;
    pass('unsigned-api-access-denied');
    phase = 'browser-cors';
    report.cors = [];
    for (const origin of ['https://weaz.me', 'http://localhost:5173']) {
      const preflight = await fetch(signedPut, { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,cache-control',
      }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const allowedHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      report.cors.push({ origin, status: preflight.status,
        allowed: preflight.ok && preflight.headers.get('access-control-allow-origin') === origin &&
          /PUT/i.test(preflight.headers.get('access-control-allow-methods') ?? '') &&
          ['content-type', 'cache-control'].every((header) => allowedHeaders.includes(header)) });
    }
    const untrusted = await fetch(signedPut, { method: 'OPTIONS', headers: {
      Origin: 'https://untrusted.invalid', 'Access-Control-Request-Method': 'PUT',
    }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    report.untrustedOriginDenied = untrusted.headers.get('access-control-allow-origin') !== 'https://untrusted.invalid' &&
      untrusted.headers.get('access-control-allow-origin') !== '*';
  } catch (error) {
    // Never log exception messages/stacks: SDK and fetch errors may contain bearer URLs.
    report.failure = { phase, code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : String(error?.code ?? error?.name ?? 'Error'),
      httpStatus: error?.$metadata?.httpStatusCode ?? report.httpStatus ?? null };
  } finally {
    if (client) {
      try {
        const deleted = await client.send(new DeleteObjectsCommand({ Bucket: report.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        if (deleted.Errors?.length) throw new Error('DELETE_REJECTED');
        for (const key of keys) {
          try {
            await client.send(new HeadObjectCommand({ Bucket: report.bucket, Key: key }));
            throw new Error('TEST_OBJECT_STILL_EXISTS');
          } catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; }
        }
        report.cleanup = true;
      } catch (error) { report.cleanupFailure = { code: String(error?.name ?? 'Error'), httpStatus: error?.$metadata?.httpStatusCode ?? null }; }
      client.destroy();
    }
    const directory = path.join(__dirname, '../docs/storage/evidence');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'r2-sit-storage-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.failure || !report.cleanup || !report.cors?.every((entry) => entry.allowed) || !report.untrustedOriginDenied ? 1 : 0;
  }
}
main().catch(() => { process.stderr.write('R2 probe could not complete; no secret details logged.\n'); process.exitCode = 1; });
