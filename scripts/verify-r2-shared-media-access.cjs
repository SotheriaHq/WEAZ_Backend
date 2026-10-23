// Run: node scripts/verify-r2-shared-media-access.cjs (loopback DATABASE_URL with CREATEDB).
// Extracts current authorization methods and canonical role defaults; application data is never queried or mutated.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const backend = path.resolve(__dirname, '..');
const localRequire = createRequire(path.join(backend, 'package.json'));
const ts = localRequire('typescript');
const { Prisma, BrandMemberRole, BrandMemberStatus } = localRequire('@prisma/client');
const { Client, Pool } = localRequire('pg');
localRequire('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const compile = (source, globals = {}) => {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(globals), output)(localRequire, exports, ...Object.values(globals));
  return exports;
};
const method = (filename, names) => {
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(parsed))) found.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (found.length !== names.length) throw new Error('Expected source methods missing');
  return `class Snippet {${found.join('\n')}}; exports.Snippet=Snippet;`;
};

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(source.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('Local PostgreSQL required');
  const permissions = compile(fs.readFileSync(path.join(backend, 'src/brands/permissions/brand-permissions.ts'), 'utf8'));
  const Permission = compile(method(path.join(backend, 'src/brands/permissions/brand-permission.service.ts'), ['validatePermissionCode', 'buildPermissionPredicate']), {
    Prisma, BrandMemberRole, ...permissions, BadRequestException: class extends Error {},
  }).Snippet;
  const Upload = compile(method(path.join(backend, 'src/upload/upload.service.ts'), ['loadSharedViewerFileIds']), { Prisma, BRAND_PERMISSIONS: permissions.BRAND_PERMISSIONS }).Snippet;
  const database = `wiez_r2_auth_${Date.now()}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let pool; let created = false; const checks = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2, statement_timeout: 10000 });
    await pool.query(`
      CREATE TYPE "BrandMemberRole" AS ENUM(${Object.values(BrandMemberRole).map((role) => `'${role}'`).join(',')});
      CREATE TABLE "FileUpload"("_id" uuid PRIMARY KEY);
      CREATE TABLE "Collection"("_id" uuid PRIMARY KEY,"ownerId" uuid,status text,visibility text,"deletedAt" timestamp);
      CREATE TABLE "CollectionMedia"("collectionId" uuid,"fileUploadId" uuid);
      CREATE TABLE "CollectionAccess"("viewerId" uuid,state text,"collectionId" uuid);
      CREATE TABLE "MessageAttachment"("messageId" uuid,"fileUploadId" uuid);
      CREATE TABLE "Message"(id uuid PRIMARY KEY,"threadId" uuid,"visibilityState" text);
      CREATE TABLE "MessageThread"(id uuid PRIMARY KEY,"brandId" uuid,"orderId" uuid,"customOrderId" uuid);
      CREATE TABLE "MessageThreadParticipant"("threadId" uuid,"userId" uuid);
      CREATE TABLE "Order"("_id" uuid PRIMARY KEY,"brandId" uuid);
      CREATE TABLE "CustomOrder"(id uuid PRIMARY KEY,"brandId" uuid);
      CREATE TABLE "Brand"("_id" uuid PRIMARY KEY,"ownerId" uuid UNIQUE);
      CREATE TABLE "BrandMember"(id uuid PRIMARY KEY,"brandId" uuid,"userId" uuid,status text,role "BrandMemberRole");
      CREATE TABLE "BrandPermissionGrant"("brandMemberId" uuid,"permissionCode" text);
    `);
    const id = Object.fromEntries(['brandA','brandB','ownerA','ownerB','participant','manager','support','catalog','viewer','inactive','outsider','messageFile','privateFile','otherFile','unattached','thread','message','target','grant','otherCollection','order','custom'].map((key) => [key, randomUUID()]));
    await pool.query('INSERT INTO "Brand" VALUES($1,$2),($3,$4)', [id.brandA,id.ownerA,id.brandB,id.ownerB]);
    await pool.query('INSERT INTO "FileUpload" VALUES($1),($2),($3),($4)', [id.messageFile,id.privateFile,id.otherFile,id.unattached]);
    await pool.query(`INSERT INTO "Collection" VALUES($1,$2,'PUBLISHED','PRIVATE',NULL),($3,$2,'PUBLISHED','PRIVATE',NULL),($4,$5,'PUBLISHED','PRIVATE',NULL)`, [id.target,id.ownerA,id.grant,id.otherCollection,id.ownerB]);
    await pool.query('INSERT INTO "CollectionMedia" VALUES($1,$2),($3,$4)', [id.target,id.privateFile,id.otherCollection,id.otherFile]);
    await pool.query(`INSERT INTO "CollectionAccess" VALUES($1,'APPROVED',$2)`, [id.participant,id.grant]);
    await pool.query('INSERT INTO "MessageThread" VALUES($1,$2,NULL,NULL)', [id.thread,id.brandA]);
    await pool.query(`INSERT INTO "Message" VALUES($1,$2,'VISIBLE')`, [id.message,id.thread]);
    await pool.query('INSERT INTO "MessageAttachment" VALUES($1,$2)', [id.message,id.messageFile]);
    await pool.query('INSERT INTO "MessageThreadParticipant" VALUES($1,$2)', [id.thread,id.participant]);
    await pool.query('INSERT INTO "Order" VALUES($1,$2)', [id.order,id.brandA]);
    await pool.query('INSERT INTO "CustomOrder" VALUES($1,$2)', [id.custom,id.brandA]);
    const memberIds = {};
    for (const [key, role] of [['manager','MANAGER'],['support','SUPPORT_AGENT'],['catalog','CATALOG_MANAGER'],['viewer','VIEWER'],['inactive','SUPPORT_AGENT'],['outsider','SUPPORT_AGENT']]) {
      const member = memberIds[key] = randomUUID();
      await pool.query('INSERT INTO "BrandMember" VALUES($1,$2,$3,$4,$5)', [member,key==='outsider'?id.brandB:id.brandA,id[key],key==='inactive'?Object.values(BrandMemberStatus).find((value)=>value!=='ACTIVE'):'ACTIVE',role]);
    }
    await pool.query(`INSERT INTO "BrandPermissionGrant" VALUES($1,'messages.read')`, [memberIds.catalog]);
    let sqlCalls=0, privateEnabled='true';
    const upload = Object.assign(new Upload(), {
      configService: { get: () => privateEnabled }, brandPermissions: new Permission(),
      prisma: { $queryRaw: async (sql) => { sqlCalls++; return (await pool.query(sql.text,sql.values)).rows; } },
    });
    async function check(name, viewer, expected, files=[id.messageFile]) {
      sqlCalls=0;
      const result = [...await upload.loadSharedViewerFileIds(files,viewer)].sort();
      checks.push({name,pass:JSON.stringify(result)===JSON.stringify([...expected].sort()) && sqlCalls===(files.length?1:0),expectedCount:expected.length,actualCount:result.length,sqlCalls});
    }
    await check('participant plus approved access extends to another collection from the same brand',id.participant,[id.messageFile,id.privateFile],[id.messageFile,id.privateFile,id.otherFile,id.unattached]);
    await check('brand owner without participant membership',id.ownerA,[id.messageFile]);
    await check('unrelated brand owner denied',id.ownerB,[]);
    await check('manager default read permission',id.manager,[id.messageFile]);
    await check('support default read permission',id.support,[id.messageFile]);
    await check('explicit read grant for catalog manager',id.catalog,[id.messageFile]);
    await check('viewer role without messages.read denied',id.viewer,[]);
    await check('inactive membership denied',id.inactive,[]);
    await check('another brand membership denied',id.outsider,[]);
    await pool.query('DELETE FROM "BrandPermissionGrant" WHERE "brandMemberId"=$1',[memberIds.catalog]);
    await check('revoked explicit permission denied',id.catalog,[]);
    for (const visibility of ['HIDDEN','REDACTED']) {
      await pool.query('UPDATE "Message" SET "visibilityState"=$1',[visibility]);
      await check(`${visibility} attachment denied to participant`,id.participant,[]);
      await check(`${visibility} attachment denied to brand reader`,id.manager,[]);
    }
    await pool.query(`UPDATE "Message" SET "visibilityState"='VISIBLE'`);
    await pool.query('UPDATE "MessageThread" SET "brandId"=NULL,"orderId"=$1',[id.order]);
    await check('legacy order brand fallback',id.ownerA,[id.messageFile]);
    await pool.query('UPDATE "MessageThread" SET "orderId"=NULL,"customOrderId"=$1',[id.custom]);
    await check('legacy custom order brand fallback',id.manager,[id.messageFile]);
    await pool.query('UPDATE "MessageThread" SET "customOrderId"=NULL,"brandId"=$1',[id.ownerA]);
    await check('brand owner alias resolves owner grant',id.ownerA,[id.messageFile]);
    await check('brand owner alias resolves team grant',id.manager,[id.messageFile]);
    await pool.query('UPDATE "MessageThread" SET "brandId"=$1,"orderId"=$2',[id.brandB,id.order]);
    await check('direct brand takes precedence over legacy order brand',id.ownerA,[]);
    await pool.query(`UPDATE "CollectionAccess" SET state='PENDING'`);
    await check('revoked private collection approval',id.participant,[],[id.privateFile]);
    await pool.query(`UPDATE "CollectionAccess" SET state='APPROVED'`);
    await pool.query('UPDATE "Collection" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "_id"=$1',[id.grant]);
    await check('deleted approval source collection denied',id.participant,[],[id.privateFile]);
    await pool.query('UPDATE "Collection" SET "deletedAt"=NULL WHERE "_id"=$1',[id.grant]);
    await pool.query(`UPDATE "Collection" SET status='DRAFT' WHERE "_id"=$1`,[id.target]);
    await check('draft target collection denied',id.participant,[],[id.privateFile]);
    await pool.query(`UPDATE "Collection" SET status='PUBLISHED',"deletedAt"=CURRENT_TIMESTAMP WHERE "_id"=$1`,[id.target]);
    await check('deleted target collection denied',id.participant,[],[id.privateFile]);
    await pool.query('UPDATE "Collection" SET "deletedAt"=NULL WHERE "_id"=$1',[id.target]);
    privateEnabled='false';
    await check('private collection feature disabled',id.participant,[],[id.privateFile]);
    await check('empty batch performs no query',id.participant,[],[]);
    const evidence={source:'exact UploadService.loadSharedViewerFileIds and BrandPermissionService.buildPermissionPredicate',checks};
    fs.mkdirSync(path.join(backend,'docs/storage/evidence'),{recursive:true});
    fs.writeFileSync(path.join(backend,'docs/storage/evidence/verify-r2-shared-media-access.json'),JSON.stringify(evidence,null,2));
    process.stdout.write(JSON.stringify({total:checks.length,passed:checks.filter((check)=>check.pass).length,failures:checks.filter((check)=>!check.pass)}));
    if(checks.some((check)=>!check.pass))process.exitCode=1;
  } finally {
    if(pool) await pool.end();
    if(created && /^wiez_r2_auth_\d+$/.test(database)) await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  }
}
main().catch((error)=>{process.stderr.write(error.message);process.exitCode=1;});
