// Run: node scripts/verify-r2-finalize-concurrency.cjs (loopback DATABASE_URL with CREATEDB).
// Uses a disposable narrow schema; verifies source SQL and generated-Prisma claims, not full migrations or capacity.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const backend = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(backend, 'package.json'));
const ts = localRequire('typescript');
const { Prisma, PrismaClient, PresignStatus } = localRequire('@prisma/client');
const { PrismaPg } = localRequire('@prisma/adapter-pg');
const { Client, Pool } = localRequire('pg');
localRequire('dotenv').config({ path: path.join(backend, '.env'), quiet: true });

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('Local PostgreSQL required');
  const filename = path.join(backend, 'src/upload/upload.service.ts');
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  let statement;
  let claimStatement;
  function scan(node, inFinalize = false) {
    if (ts.isMethodDeclaration(node)) inFinalize = node.name.getText(parsed) === 'finalizeStoredUpload';
    if (inFinalize && ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'claimed') claimStatement = node.initializer.getText(parsed);
    if (inFinalize && ts.isCallExpression(node) && node.expression.getText(parsed) === 'this.prisma.$transaction') {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
        const beforeGuard = [];
        for (const step of callback.body.statements) {
          if (ts.isIfStatement(step)) break;
          if (step.getText(parsed).includes('tx.$queryRaw')) beforeGuard.push(step.getText(parsed));
        }
        if (beforeGuard.some((step) => step.includes('finalizeLeaseToken'))) statement = beforeGuard.join('\n');
      }
    }
    ts.forEachChild(node, (child) => scan(child, inFinalize));
  }
  scan(parsed);
  if (!statement || !statement.includes('finalizeLeaseToken')) throw new Error('Expected production lease-fence SQL missing');
  const compiled = ts.transpileModule(`exports.run=async function(tx,presign,userId,token){${statement}\n return owned;};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const moduleExports = {}; new Function('exports', compiled)(moduleExports);
  const connectionExports = {};
  const connectionSource = fs.readFileSync(path.join(backend, 'src/prisma/database-connection.ts'), 'utf8');
  new Function('exports', ts.transpileModule(connectionSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(connectionExports);
  if (!claimStatement) throw new Error('Expected production lease claim missing');
  const compiledClaim = ts.transpileModule(`exports.claim=async function(presign,userId,token,targetKey,now){return ${claimStatement};};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', compiledClaim)(moduleExports);
  const database = `wiez_r2_validation_${Date.now()}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('connection_limit', '4');
  testUrl.searchParams.set('schema', 'public');
  // Intentionally exercise UTC timestamp SQL even when the server session uses local wall time.
  testUrl.searchParams.set('options', '-c timezone=Africa/Lagos');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let pool; let prisma; let created = false; const checks = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4, statement_timeout: 10000 });
    const fixtureTimeZone = (await pool.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone;
    if (fixtureTimeZone !== 'Africa/Lagos') throw new Error('Expected non-UTC fixture timezone');
    await pool.query(`CREATE TYPE "PresignStatus" AS ENUM(${Object.values(PresignStatus).map((value) => `'${value}'`).join(',')})`);
    await pool.query('CREATE TABLE "PresignedUpload"("_id" uuid PRIMARY KEY,"userId" uuid,"finalizeLeaseToken" uuid,"finalizeLeaseUntil" timestamp(3),status "PresignStatus","finalizeTargetKey" text,"expiresAt" timestamp(3),"updatedAt" timestamp(3))');
    const id = randomUUID(), userId = randomUUID(), token = randomUUID();
    await pool.query(`INSERT INTO "PresignedUpload"("_id","userId","finalizeLeaseToken","finalizeLeaseUntil",status,"expiresAt","updatedAt") VALUES($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '5 minutes','READY',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '10 minutes',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`, [id, userId, token]);
    const tx = (client) => ({ $queryRaw: async (strings, ...values) => {
      const sql = Prisma.sql(strings, ...values); return (await client.query(sql.text, sql.values)).rows;
    } });
    async function execute(client, actor, lease) {
      await client.query('BEGIN');
      try { return await moduleExports.run(tx(client), { id }, actor, lease); }
      finally { await client.query('ROLLBACK'); }
    }
    async function check(name, actor, lease, expected) {
      const client = await pool.connect();
      try {
        const result = await execute(client, actor, lease);
        checks.push({ category: 'publish-fence', name, expectedRows: expected, actualRows: result.length, pass: result.length === expected });
      } finally { client.release(); }
    }
    await check('active owner lease', userId, token, 1);
    await check('wrong owner', randomUUID(), token, 0);
    await check('stale token', userId, randomUUID(), 0);
    await pool.query(`UPDATE "PresignedUpload" SET "finalizeLeaseUntil"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '1 second'`);
    await check('expired lease', userId, token, 0);
    await pool.query(`UPDATE "PresignedUpload" SET "finalizeLeaseUntil"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '5 minutes',status='USED'`);
    await check('already finalized', userId, token, 0);
    await pool.query(`UPDATE "PresignedUpload" SET "finalizeLeaseUntil"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '3 seconds',status='READY'`);
    const blocker = await pool.connect(), waiter = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM "PresignedUpload" FOR UPDATE');
      const pending = execute(waiter, userId, token).then(
        (value) => ({ value }), (error) => ({ error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [waiter.processID])).rows[0];
        if (state?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!waiting) throw new Error('Fixture did not establish the expected row-lock wait');
      const deadline = (await pool.query(`SELECT "finalizeLeaseUntil" AT TIME ZONE 'UTC' AS "finalizeLeaseUntil" FROM "PresignedUpload"`)).rows[0].finalizeLeaseUntil;
      if (deadline.getTime() <= Date.now()) throw new Error('Fixture lease expired before lock waiting was observed; rerun under less contention');
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline.getTime() - Date.now() + 50)));
      await blocker.query('ROLLBACK');
      const outcome = await pending;
      if (outcome.error) throw outcome.error;
      const result = outcome.value;
      checks.push({ category: 'publish-fence', name: 'lease expires while waiting for unchanged row lock', expectedRows: 0, actualRows: result.length, pass: result.length === 0 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined); blocker.release(); waiter.release();
    }
    // Exercise the exact production updateMany through generated Prisma, without external storage I/O.
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await pool.query('UPDATE "PresignedUpload" SET "finalizeLeaseToken"=NULL,"finalizeLeaseUntil"=NULL');
    const contenders = await Promise.all(Array.from({ length: 20 }, async () => {
      const lease = randomUUID();
      const result = await moduleExports.claim.call({ prisma }, { id }, userId, lease, `test/final/${lease}`, new Date());
      return { lease, count: result.count };
    }));
    const winners = contenders.filter((result) => result.count === 1);
    checks.push({ category: 'claim', name: '20 generated-Prisma concurrent claims produce one winner', expectedRows: 1, actualRows: winners.length, pass: winners.length === 1 });
    await check('fresh generated-Prisma lease is accepted by the raw publication fence', userId, winners[0]?.lease ?? randomUUID(), 1);
    const staleRelease = await prisma.presignedUpload.updateMany({ where: { id, finalizeLeaseToken: randomUUID() }, data: { finalizeLeaseToken: null, finalizeLeaseUntil: null, finalizeTargetKey: null } });
    const persisted = (await pool.query('SELECT "finalizeLeaseToken" FROM "PresignedUpload"')).rows[0];
    checks.push({ category: 'claim', name: 'stale token cannot release the winning lease', expectedRows: 0, actualRows: staleRelease.count, pass: staleRelease.count === 0 && persisted.finalizeLeaseToken === winners[0]?.lease });
    await pool.query('UPDATE "PresignedUpload" SET "finalizeLeaseToken"=NULL,"finalizeLeaseUntil"=NULL');
    const wrongActor = await moduleExports.claim.call({ prisma }, { id }, randomUUID(), randomUUID(), 'test/wrong-owner', new Date());
    checks.push({ category: 'claim', name: 'claim denies wrong actor before storage I/O', expectedRows: 0, actualRows: wrongActor.count, pass: wrongActor.count === 0 });
    await prisma.presignedUpload.updateMany({ where: { id }, data: { expiresAt: new Date(Date.now() - 60000) } });
    const expired = await moduleExports.claim.call({ prisma }, { id }, userId, randomUUID(), 'test/expired', new Date());
    checks.push({ category: 'claim', name: 'claim denies expired upload before storage I/O', expectedRows: 0, actualRows: expired.count, pass: expired.count === 0 });
    const configuredUrl = new URL(testUrl);
    configuredUrl.searchParams.set('options', '-c statement_timeout=5000 -c timezone=Asia/Tokyo');
    const utcPool = new Pool({ connectionString: connectionExports.withUtcDatabaseUrl(configuredUrl.toString()), max: 1 });
    try {
      const settings = (await utcPool.query("SELECT current_setting('TimeZone') AS zone,current_setting('statement_timeout') AS timeout")).rows[0];
      checks.push({ category: 'startup-policy', name: 'canonical helper overrides prior URL timezone and preserves timeout', pass: settings.zone === 'UTC' && settings.timeout === '5s' });
    } finally { await utcPool.end(); }
    const previousOptions = process.env.PGOPTIONS;
    let envPool;
    try {
      process.env.PGOPTIONS = '-c timezone=Asia/Tokyo -c lock_timeout=2000';
      configuredUrl.searchParams.delete('options');
      envPool = new Pool({ connectionString: connectionExports.withUtcDatabaseUrl(configuredUrl.toString()), max: 1 });
      const settings = (await envPool.query("SELECT current_setting('TimeZone') AS zone,current_setting('lock_timeout') AS timeout")).rows[0];
      checks.push({ category: 'startup-policy', name: 'canonical helper overrides PGOPTIONS timezone and preserves lock timeout', pass: settings.zone === 'UTC' && settings.timeout === '2s' });
    } finally {
      if (envPool) await envPool.end();
      if (previousOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = previousOptions;
    }
    const evidence = { source: 'src/upload/upload.service.ts finalizeStoredUpload actual SQL and generated Prisma claims', fixtureTimeZone, checks };
    fs.mkdirSync(path.join(backend,'docs/storage/evidence'),{recursive:true});
    fs.writeFileSync(path.join(backend, 'docs/storage/evidence/verify-r2-finalize-concurrency.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(JSON.stringify(evidence));
    if (checks.some((check)=>!check.pass)) process.exitCode=1;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (created && /^wiez_r2_validation_\d+$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
}
main().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
