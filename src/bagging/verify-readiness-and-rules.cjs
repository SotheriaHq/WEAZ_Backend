// Local-only integration proof. All tables are temporary and the transaction is rolled back.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const { Client } = require(path.join(root, 'node_modules/pg'));
const dotenv = require(path.join(root, 'node_modules/dotenv'));
const env = fs.existsSync(path.join(root, '.env')) ? dotenv.parse(fs.readFileSync(path.join(root, '.env'))) : {};
const connectionString = process.env.DATABASE_URL || env.DATABASE_URL;
if (!connectionString || !['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname)) throw new Error('A verified local PostgreSQL connection is required');

function load(relative) {
  const file = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: false } }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (name.startsWith('src/')) return { PrismaService: class {}, SystemConfigService: class {} };
    return require(require.resolve(name, { paths: [root] }));
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(localRequire,module,module.exports);
  return module.exports;
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE "CartItem" ("_id" uuid, "userId" uuid, "productId" uuid, "selectedSize" text, "selectedColor" text, quantity int, "createdAt" timestamp) ON COMMIT DROP;
      CREATE TEMP TABLE "OrderItem" (id uuid, "buyerId" uuid, "productId" uuid) ON COMMIT DROP;
      CREATE TEMP TABLE "CustomOrderConfiguration" (id uuid, "sourceType" text, "sourceId" uuid, "isActive" bool, "requiredMeasurementKeys" text[], "requiredFreeformPointIds" text[], "createdAt" timestamp) ON COMMIT DROP;
      CREATE TEMP TABLE "CustomOrder" (id uuid, "buyerId" uuid, "sourceType" text, "sourceId" uuid, status text, "paymentStatus" text) ON COMMIT DROP;
      CREATE TEMP TABLE "CustomOrderCheckoutIntent" (id uuid, "configurationId" uuid) ON COMMIT DROP;
      CREATE TEMP TABLE "CustomOrderCheckoutSession" (id uuid, "buyerId" uuid, "checkoutIntentId" uuid, status text, "customOrderId" uuid, "lastAttemptStatus" text, "createdAt" timestamp) ON COMMIT DROP;
      CREATE TEMP TABLE "User" ("_id" uuid, "isEmailVerified" bool) ON COMMIT DROP;
      CREATE TEMP TABLE "Brand" ("_id" uuid, "ownerId" uuid, name text, "contentTrustTierOverride" text, "contentReviewModeOverride" text, "verificationStatus" text) ON COMMIT DROP;
      CREATE TEMP TABLE "BrandTrustEvent" ("_id" uuid, "brandId" uuid, tier text, "reviewMode" text, "eventType" text, "createdAt" timestamp) ON COMMIT DROP;
      CREATE TEMP TABLE "CommissionRule" (id uuid, scope text, "brandId" uuid, currency text, "ratePercent" numeric, "minFeeAmount" numeric, "maxFeeAmount" numeric, "isDefault" bool, "isActive" bool, "effectiveFrom" timestamp, "effectiveTo" timestamp) ON COMMIT DROP;
      CREATE TEMP TABLE "SettlementPolicy" (id uuid, "orderType" "SettlementOrderType", scope text, "brandId" uuid, currency text, "releaseMode" text, "upfrontReleaseEnabled" bool, "upfrontReleasePercent" numeric, "settlementDelayHours" int, "autoReleaseDays" int, "finalReleaseTrigger" text, "isDefault" bool, "isActive" bool, "effectiveFrom" timestamp, "effectiveTo" timestamp, "updatedAt" timestamp) ON COMMIT DROP;
    `);
    const buyer = randomUUID(), stranger = randomUUID(), owner = randomUUID();
    const products = [randomUUID(),randomUUID(),randomUUID()], brands = [randomUUID(),randomUUID(),randomUUID()];
    const oldConfig=randomUUID(), activeConfig=randomUUID(), oldIntent=randomUUID();
    await client.query('INSERT INTO "CustomOrderConfiguration" VALUES ($1,\'PRODUCT\',$3,false,\'{}\',\'{}\',\'2025-01-01\'),($2,\'PRODUCT\',$3,true,\'{WAIST}\',\'{}\',\'2026-01-01\')',[oldConfig,activeConfig,products[0]]);
    await client.query('INSERT INTO "CartItem" VALUES ($1,$3,$4,null,null,1,\'2025-01-01\'),($2,$3,$4,null,null,3,\'2026-01-01\'),($5,$6,$4,null,null,9,\'2027-01-01\')',[randomUUID(),randomUUID(),buyer,products[0],randomUUID(),stranger]);
    const previousStandard=randomUUID();
    await client.query('INSERT INTO "OrderItem" VALUES ($1,$2,$3)',[previousStandard,buyer,products[1]]);
    await client.query('INSERT INTO "CustomOrder" VALUES ($1,$3,\'PRODUCT\',$4,\'IN_PROGRESS\',\'PAID\'),($2,$3,\'PRODUCT\',$4,\'COMPLETED\',\'PAID\')',[randomUUID(),randomUUID(),buyer,products[0]]);
    await client.query('INSERT INTO "CustomOrderCheckoutIntent" VALUES ($1,$2)',[oldIntent,oldConfig]);
    const bagSession=randomUUID();
    await client.query('INSERT INTO "CustomOrderCheckoutSession" VALUES ($1,$3,$4,\'SUBMITTED\',null,null,\'2026-01-02\'),($2,$3,$4,\'SUBMITTED\',$5,null,\'2026-01-01\')',[bagSession,randomUUID(),buyer,oldIntent,randomUUID()]);
    let queryCount=0;
    const query = async sql => {queryCount++; return (await client.query(sql.text,sql.values)).rows;};
    const prisma = { $queryRaw: query };
    const {loadCollectionReadiness}=load('src/bagging/collection-readiness-query.ts');
    const rows = await loadCollectionReadiness(prisma,products,buyer);
    assert.equal(queryCount,1); assert.equal(rows.size,3);
    assert.equal(rows.get(products[0]).cartItem.quantity,3);
    assert.equal(rows.get(products[0]).customConfiguration.id,activeConfig);
    assert.equal(rows.get(products[0]).checkoutSessions[0].id,bagSession);
    assert.equal(rows.get(products[0]).customOrders.length,2);
    assert.equal(rows.get(products[1]).previousStandardOrder.id,previousStandard);
    assert.equal(rows.get(products[2]).cartItem,null);
    const guest = await loadCollectionReadiness(prisma,products);
    assert.equal(guest.get(products[0]).checkoutSessions.length,0);
    assert.equal(guest.get(products[0]).cartItem,null);
    const before=queryCount;
    const bounded = await loadCollectionReadiness(prisma,Array.from({length:501},()=>randomUUID()),buyer);
    assert.equal(bounded.size,501); assert.equal(queryCount-before,2);

    await client.query('INSERT INTO "User" VALUES ($1,true)',[owner]);
    await client.query('INSERT INTO "Brand" VALUES ($1,$2,\'Brand\',null,null,\'APPROVED\')',[brands[0],owner]);
    await client.query('INSERT INTO "BrandTrustEvent" VALUES ($1,$3,\'TRUSTED\',\'POST_REVIEW\',\'TRUST_EVALUATED\',\'2026-01-01\'),($2,$3,null,null,\'CONTENT_SUBMITTED\',\'2026-02-01\')',[randomUUID(),randomUUID(),brands[0]]);
    const {loadReviewBrands}=load('src/content-integrity/content-review-prefetch.ts');
    const reviewBrands=await loadReviewBrands(prisma,[brands[0]]);
    assert.equal(reviewBrands[0].trustTier,'TRUSTED'); assert.equal(reviewBrands[0].emailVerified,true);

    const platformRule=randomUUID(), brandRule=randomUUID(), cappedRule=randomUUID();
    await client.query('INSERT INTO "CommissionRule" VALUES ($1,\'PLATFORM\',null,\'NGN\',12,null,null,false,true,\'2025-01-01\',\'2028-01-01\'),($2,\'BRAND\',$4,null,7,null,null,false,true,\'2025-01-01\',\'2028-01-01\'),($3,\'BRAND\',$5,\'NGN\',20,5,8,false,true,\'2025-01-01\',\'2028-01-01\')',[platformRule,brandRule,cappedRule,brands[0],brands[1]]);
    const {CommissionService}=load('src/finance/commission.service.ts');
    const config={getNumber:async key=>key.includes('settlementHours')?48:key.includes('autoReleaseDays')?7:15};
    const forbiddenRoot={$queryRaw:()=>{throw new Error('Root client must not replace caller transaction');}};
    const commission=new CommissionService(forbiddenRoot,config);
    const params=[{brandId:brands[0],currency:'NGN',at:new Date('2026-01-01'),orderType:'STANDARD_ORDER'},{brandId:brands[1],currency:'NGN',at:new Date('2026-01-01'),orderType:'STANDARD_ORDER'},{brandId:brands[2],currency:'EUR',at:new Date('2030-01-01'),orderType:'STANDARD_ORDER'}];
    const rules=await commission.calculateBreakdownsBatch(params.map(params=>({amount:100,params})),prisma);
    assert.equal(rules[0].ruleId,brandRule); assert.equal(rules[0].commissionAmount,7);
    assert.equal(rules[1].commissionAmount,8); assert.equal(rules[2].ratePercent,15);
    const platformPolicy=randomUUID(), brandPolicy=randomUUID();
    await client.query('INSERT INTO "SettlementPolicy" VALUES ($1,\'STANDARD_ORDER\',\'PLATFORM\',null,\'NGN\',\'HOLD_UNTIL_DELIVERY\',false,0,48,7,\'BUYER_CONFIRMATION\',false,true,\'2025-01-01\',null,\'2025-01-01\'),($2,\'STANDARD_ORDER\',\'BRAND\',$3,null,\'SPLIT_RELEASE\',true,30,24,5,\'BUYER_CONFIRMATION\',false,true,\'2025-01-01\',null,\'2025-01-01\')',[platformPolicy,brandPolicy,brands[0]]);
    const {SettlementPolicyService}=load('src/finance/settlement-policy.service.ts');
    const policy=new SettlementPolicyService(forbiddenRoot,config);
    const policies=await policy.resolveActivePoliciesBatch(params.map(params=>({...params,orderType:'STANDARD_ORDER'})),prisma);
    assert.equal(policies[0].id,brandPolicy); assert.equal(policies[0].upfrontReleasePercent,30);
    assert.equal(policies[1].id,platformPolicy); assert.equal(policies[2].id,null);
    assert.equal(policies[2].currency,'EUR'); assert.equal(policies[2].effectiveFrom.toISOString(),'2030-01-01T00:00:00.000Z');
    console.log(JSON.stringify({passed:true,scope:'local temporary tables only',checks:['buyer isolation','latest cart','inactive configuration history','guest isolation','501-ID bounded projection','latest non-null trust event','brand/currency commission precedence','fee cap','rule fallback','policy precedence/fallback','caller transaction preserved'],queryCount}));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
