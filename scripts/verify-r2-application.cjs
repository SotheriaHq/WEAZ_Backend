// Real R2 + disposable PostgreSQL + uniquely prefixed Redis queue. Uses actual
// upload HTTP controller/JWT strategy, service and image-processing worker.
// No application DB, active environment or deployment is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Queue, Worker } = require('bullmq');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const { parse } = require('dotenv');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { Logger } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { ThrottlerModule } = require('@nestjs/throttler');
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../src/prisma/prisma.service');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { UploadService } = require('../src/upload/upload.service');
const { UploadController } = require('../src/upload/upload.controller');
const { FileType } = require('../src/upload/upload.enums');
const { SystemConfigService } = require('../src/admin/system-config/system-config.service');
const { ImageProcessingQueueService } = require('../src/queue/image-processing.queue.service');
const { ImageProcessingProcessor } = require('../src/queue/image-processing.processor');
const { MediaProcessingService } = require('../src/media-processing/media-processing.service');
const { BrandPermissionService } = require('../src/brands/permissions/brand-permission.service');
const { S3Client, DeleteObjectsCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { storageHelpers } = require('./verify-r2-media-gateway.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const request = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
async function waitFor(probe, description, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out: ${description}`);
}

async function main() {
  Logger.overrideLogger(false);
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback PostgreSQL required');
  const privateConfig = parse(await fs.readFile(path.resolve('.env.r2.local')));
  assert.equal(privateConfig.R2_BUCKET, 'wiez-sit-media');
  const { resolveStorageProviderSettings } = storageHelpers();
  const config = new ConfigService({ ...privateConfig, STORAGE_PROVIDER: 'R2', NODE_ENV: 'test',
    IMAGE_OPTIMIZATION_ENABLED: 'true', JWT_ACCESS_SECRET: randomBytes(40).toString('base64url') });
  const settings = resolveStorageProviderSettings(config);
  assert.equal(settings.publicGateway?.environment, 'sit');
  const id = randomUUID().replaceAll('-', '');
  const database = `wiez_r2_application_${id}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 10_000 });
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false,
    scope: 'Actual upload HTTP/JWT boundary, services, R2/Worker and local Redis; no full app, browser or device certification',
    cases: [], antivirus: 'Deferred explicitly by product owner; no malware-free claim' };
  let created = false, prisma, upload, app, queue, worker, cleanupClient;
  let phase = 'database-create';
  const objectKeys = new Set();
  const pass = name => evidence.cases.push(name);
  const owner = randomUUID(), stranger = randomUUID();
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    phase = 'full-migrations';
    const migrationExit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: process.cwd(), windowsHide: true, stdio: 'ignore',
        env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' },
      });
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(migrationExit, 0, 'Fresh migrations must succeed');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString() }) });
    await prisma.user.createMany({ data: [owner, stranger].map(userId => ({ id: userId, username: userId, email: `${userId}@example.invalid` })) });
    phase = 'isolated-image-queue';
    const queueOptions = { prefix: `wiez-r2-validation-${id}`, connection: { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null } };
    queue = new Queue('image-processing', queueOptions);
    await queue.waitUntilReady();
    const media = new MediaProcessingService();
    upload = new UploadService(prisma, config, new SystemConfigService(prisma), undefined, new ImageProcessingQueueService(queue), new BrandPermissionService(prisma));
    const processor = new ImageProcessingProcessor(prisma, upload, media);
    const workerErrors = [];
    worker = new Worker('image-processing', job => processor.process(job), { ...queueOptions, concurrency: 2 });
    worker.on('error', error => workerErrors.push(error.name));
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [UploadController], providers: [JwtStrategy,
        { provide: PrismaService, useValue: prisma }, { provide: ConfigService, useValue: config },
        { provide: UploadService, useValue: upload }, { provide: MediaProcessingService, useValue: media }],
    }).compile();
    app = module.createNestApplication({ logger: false }); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const token = userId => jwt.sign({ sub: userId, authVersion: 0 }, config.get('JWT_ACCESS_SECRET'), { expiresIn: '10m' });
    const call = (route, userId, body) => request(`${origin}/uploads/${route}`, {
      headers: { ...(userId ? { Authorization: `Bearer ${token(userId)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const bytes = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#7834b6' } }).png().toBuffer();
    phase = 'http-auth-multipart';
    assert.equal((await request(`${origin}/uploads/profile-image`, { method: 'POST' })).status, 401);
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'Adiré studio.png');
    const uploadedResponse = await request(`${origin}/uploads/profile-image`, { method: 'POST', headers: { Authorization: `Bearer ${token(owner)}` }, body: form });
    assert.equal(uploadedResponse.status, 201);
    const profileFile = await uploadedResponse.json();
    assert(profileFile.key.startsWith(`PROFILE_IMAGE/${owner}/final/`));
    assert(!profileFile.key.includes('studio') && !profileFile.key.includes('Adir'));
    assert.equal(digest(await upload.getObjectBufferByKey(profileFile.key)), digest(bytes));
    pass('actual HTTP multipart upload requires JWT, uses a generated immutable private key and preserves original bytes');
    const publicProfile = await call(`public-url/${profileFile.id}`);
    assert.equal(publicProfile.status, 200);
    const profileUrl = (await publicProfile.json()).url;
    assert.equal(new URL(profileUrl).origin, settings.publicGateway.baseUrl);
    assert.equal((await request(profileUrl)).status, 200);
    pass('public profile media is authorized by its current profile relation and delivered by the real Worker');

    phase = 'private-presigned-put';
    const intent = await upload.createPresignedPost(owner, 'collection-look.png', FileType.POST_IMAGE, 'image/png');
    objectKeys.add(intent.key);
    assert.equal(intent.method, 'PUT'); assert.deepEqual(intent.fields, {});
    assert.equal((await request(intent.url, { method: 'PUT', headers: intent.uploadHeaders, body: bytes })).status, 200);
    await assert.rejects(() => upload.createFileRecordFromPresign(intent.fileId, stranger, intent.key, 'image/png', bytes.length));
    await assert.rejects(() => upload.createFileRecordFromPresign(intent.fileId, owner, `${intent.key}.wrong`, 'image/png', bytes.length));
    pass('direct R2 PUT uses the exact signed headers and finalization rejects another user or key');
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => upload.createFileRecordFromPresign(intent.fileId, owner, intent.key, 'image/png', bytes.length)));
    assert(outcomes.some(outcome => outcome.status === 'fulfilled'));
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.getStatus?.(), 409);
    const file = await prisma.fileUpload.findUniqueOrThrow({ where: { id: intent.fileId } });
    assert.equal(await prisma.fileUpload.count({ where: { id: intent.fileId } }), 1);
    assert.notEqual(file.s3Key, intent.key);
    await prisma.presignedUpload.update({ where: { id: intent.fileId }, data: { expiresAt: new Date(0) } });
    assert.equal((await upload.createFileRecordFromPresign(intent.fileId, owner, intent.key, 'image/png', bytes.length)).id, file.id);
    assert.equal((await request(intent.url, { method: 'PUT', headers: intent.uploadHeaders, body: Buffer.from('overwritten staging') })).status, 200);
    assert.equal(digest(await upload.getObjectBufferByKey(file.s3Key)), digest(bytes));
    pass('eight finalizers commit one file; retries work after intent expiry and reused PUTs cannot overwrite finalized bytes');

    phase = 'image-worker';
    await waitFor(async () => (await prisma.fileUpload.findUnique({ where: { id: file.id } }))?.lastProcessedAt, 'image worker');
    const variants = await prisma.fileVariant.findMany({ where: { fileUploadId: file.id } });
    assert(variants.length >= 6); evidence.generatedVariants = variants.length;
    for (const variant of variants) {
      const variantBytes = await upload.getObjectBufferByKey(variant.s3Key);
      assert.equal(variantBytes.length, variant.sizeBytes);
      const metadata = await sharp(variantBytes).metadata();
      assert.equal(metadata.width, variant.width); assert.equal(metadata.height, variant.height);
    }
    assert.deepEqual(workerErrors, []);
    pass('the actual image worker consumes a uniquely isolated Redis queue and publishes decodable R2 variants');

    phase = 'http-private-access';
    assert.equal((await call(`signed-url/${file.id}`)).status, 401);
    assert.equal((await call(`signed-url/${file.id}`, stranger)).status, 400);
    assert.equal((await call(`public-url/${file.id}`)).status, 400);
    const ownerSigned = await call(`signed-url/${file.id}`, owner); assert.equal(ownerSigned.status, 200);
    assert.equal((await request((await ownerSigned.json()).url)).status, 200);
    assert.equal((await call(`${file.id}/variants`, stranger)).status, 400);
    pass('actual HTTP private original and variant access deny anonymous and other-account requests');
    const variant = variants.find(row => row.variantKind === 'CARD'); assert(variant);
    const publicBatch = await call('public-urls-by-source', undefined, { urls: [variant.s3Url] });
    assert.equal((await publicBatch.json()).items[0].url, null);
    const ownerBatch = await call('signed-urls-by-source', owner, { urls: [variant.s3Url, 'https://untrusted.invalid/file.png'] });
    const resolved = (await ownerBatch.json()).items;
    assert.equal(resolved[1].url, null);
    const resolvedBytes = await request(resolved[0].url); assert.equal(resolvedBytes.status, 200);
    assert.equal(digest(Buffer.from(await resolvedBytes.arrayBuffer())), digest(await upload.getObjectBufferByKey(variant.s3Key)));
    pass('HTTP batch renewal retains the selected variant, enforces parent ownership and refuses arbitrary origins');

    phase = 'malformed-content';
    for (const [name, contentType, badBytes] of [
      ['script.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')],
      ['truncated.png', 'image/png', bytes.subarray(0, Math.floor(bytes.length / 2))],
    ]) {
      const bad = await upload.createPresignedPost(owner, name, FileType.POST_IMAGE, contentType);
      objectKeys.add(bad.key);
      assert.equal((await request(bad.url, { method: 'PUT', headers: bad.uploadHeaders, body: badBytes })).status, 200);
      await assert.rejects(() => upload.createFileRecordFromPresign(bad.fileId, owner, bad.key, contentType, badBytes.length));
      assert.equal(await prisma.fileUpload.count({ where: { id: bad.fileId } }), 0);
    }
    const beforeUnsafe = await prisma.presignedUpload.count();
    for (const [name, mime] of [['../file.png', 'image/png'], ['file.php.png', 'image/png'], ['file.png', 'image/jpeg'], ['file.svg', 'image/svg+xml']]) {
      await assert.rejects(() => upload.createPresignedPost(owner, name, FileType.POST_IMAGE, mime));
    }
    assert.equal(await prisma.presignedUpload.count(), beforeUnsafe);
    pass('HTML disguised as an image and truncated image bytes cannot become files; unsafe names/types cannot create upload capabilities');

    phase = 'failed-content-and-revocation';
    await prisma.fileUpload.update({ where: { id: file.id }, data: { processingStatus: 'FAILED' } });
    assert.equal((await call(`signed-url/${file.id}`, owner)).status, 400);
    await prisma.fileUpload.update({ where: { id: file.id }, data: { processingStatus: 'READY' } });
    await prisma.user.update({ where: { id: owner }, data: { authVersion: { increment: 1 } } });
    assert.equal((await call(`signed-url/${file.id}`, owner)).status, 401);
    await upload.clearUserProfileImage(owner);
    assert.equal((await call(`public-url/${profileFile.id}`)).status, 400);
    pass('failed content cannot renew, revoked sessions are refused and removed profile relations stop new public capabilities');
    evidence.passed = true;
  } catch (error) {
    evidence.failure = { phase, code: error.code || error.name || 'Error' };
  } finally {
    try {
      await app?.close(); await worker?.close();
      if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
      if (prisma) {
        for (const model of [prisma.presignedUpload, prisma.fileUpload, prisma.fileVariant, prisma.storageObjectDeletion]) {
          for (const row of await model.findMany({ select: { s3Key: true } })) objectKeys.add(row.s3Key);
        }
      }
      cleanupClient = new S3Client({ region: settings.region, endpoint: settings.endpoint, forcePathStyle: true,
        credentials: settings.credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
      const keys = [...objectKeys];
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const deleted = await cleanupClient.send(new DeleteObjectsCommand({ Bucket: settings.bucket, Delete: { Objects: keys.slice(offset, offset + 1000).map(Key => ({ Key })) } }));
        assert.equal(deleted.Errors?.length || 0, 0);
      }
      for (const Key of keys) {
        await assert.rejects(() => cleanupClient.send(new HeadObjectCommand({ Bucket: settings.bucket, Key })), error => error.$metadata?.httpStatusCode === 404);
      }
      evidence.cleanedObjects = keys.length;
      await prisma?.$disconnect(); upload?.s3?.destroy(); cleanupClient?.destroy();
      if (created) {
        assert(/^wiez_r2_application_[a-f0-9]{32}$/.test(database));
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
        await admin.query(`DROP DATABASE "${database}"`);
      }
      evidence.cleanupPassed = true;
    } catch (error) { evidence.cleanupFailure = error.code || error.name || 'Error'; }
    await admin.end();
    await fs.mkdir('docs/storage/evidence', { recursive: true });
    await fs.writeFile('docs/storage/evidence/r2-application.json', `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
    if (!evidence.passed || !evidence.cleanupPassed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(JSON.stringify({ failure: error.code || error.name || 'Error', details: 'Private configuration omitted' })); process.exitCode = 1; });
