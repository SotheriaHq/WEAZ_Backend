// Actual service locks/guards and generated Prisma in a disposable PostgreSQL DB.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { CustomOrdersService } = require('../src/custom-orders/custom-orders.service');
const { CustomOrderOpsCronService } = require('../src/custom-order-ops/custom-order-ops.cron.service');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_issue_race_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`; testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false, prisma, pool;
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  const waitForBlocked = async () => {
    for (let i=0;i<300;i++) {
      const result = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error('Expected competing transaction to wait on the order lock');
  };
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const code = await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'], {
        cwd:path.resolve(__dirname,'..'), env:{...process.env,DATABASE_URL:testUrl.toString(),THREADLY_PRISMA_SKIP_SEED:'true'},
        windowsHide:true,stdio:'ignore',
      }); child.once('error',reject); child.once('close',resolve);
    });
    assert.equal(code,0,'Disposable migrations must succeed');
    pool = new Pool({ connectionString:testUrl.toString() });
    pool.on('error',(error)=>{ console.error('Disposable pool error:',error.code);process.exitCode=1; });
    prisma = new PrismaClient({adapter:new PrismaPg(pool)});
    const buyer = await prisma.user.create({data:{id:randomUUID(),username:'race-buyer',email:'race-buyer@example.invalid'}});
    const owner = await prisma.user.create({data:{id:randomUUID(),username:'race-maker',email:'race-maker@example.invalid',type:'BRAND'}});
    const brand = await prisma.brand.create({data:{id:randomUUID(),name:'Race fixture',ownerId:owner.id}});
    const basis = await prisma.customFabricRuleBasis.create({data:{label:'Race fixture',brandId:brand.id}});
    const configuration = await prisma.customOrderConfiguration.create({data:{
      brandId:brand.id,sourceType:'DESIGN',sourceId:randomUUID(),title:'Race fixture',fabricRuleBasisId:basis.id,
      baseProductionCharge:100,fabricCostPerYard:0,productionLeadDays:1,deliveryMinDays:1,deliveryMaxDays:2,
      deliveryScope:'LOCAL',revisionPolicy:'Fixture',returnPolicy:'Fixture',defectPolicy:'Fixture',fabricSourcingMode:'BRAND_SOURCED',
    }});
    const version = await prisma.customOrderConfigurationVersion.create({data:{configurationId:configuration.id,version:1,snapshotJson:{},createdById:owner.id}});
    const createOrder = () => prisma.customOrder.create({data:{
      brandId:brand.id,buyerId:buyer.id,sourceType:'DESIGN',sourceId:configuration.sourceId,sourceTitleSnapshot:'Race fixture',
      configurationId:configuration.id,configurationVersionId:version.id,status:'DELIVERED_PENDING_BUYER_CONFIRMATION',paymentStatus:'PAID',
      baseProductionChargeSnapshot:100,fabricCostPerYardSnapshot:0,computedYards:0,
      internalPriceBreakdownJson:{},buyerPriceSummaryJson:{grandTotal:100},measurementSnapshotJson:{},measurementConfirmedAt:new Date(),
      productionLeadDaysSnapshot:1,deliveryMinDaysSnapshot:1,deliveryMaxDaysSnapshot:2,buyerAcceptanceWindowEndsAt:new Date(Date.now()-3600000),
    }});
    const service = Object.assign(Object.create(CustomOrdersService.prototype),{prisma});
    const first = await createOrder();
    const held = deferred(), release = deferred();
    const complaint = prisma.$transaction(async(tx)=>{
      await service.lockBuyerOrderForIssue(tx,buyer.id,first.id); held.resolve(); await release.promise;
      await tx.customOrderIssue.create({data:{customOrderId:first.id,issueType:'UNREASONABLE_DELAY',description:'Fixture',openedById:buyer.id}});
    },{timeout:15000});
    await held.promise;
    const notices=[],warnings=[],financial=[];
    const cron = Object.assign(Object.create(CustomOrderOpsCronService.prototype),{
      prisma, sideEffects:{enqueueNotification:async(payload)=>notices.push(payload)},
      ledgerService:{postCustomOrderFinalRelease:async(payload)=>financial.push(payload)},
      logger:{warn:(message)=>warnings.push(message),log:()=>{}},
    });
    const completing = cron.autoCompleteExpiredAcceptanceWindows();
    try { await waitForBlocked(); } finally { release.resolve(); }
    await complaint; await completing;
    assert.deepEqual(warnings,[]); assert.equal(notices.length,0); assert.equal(financial.length,0);
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:first.id}})).status,'DELIVERED_PENDING_BUYER_CONFIRMATION');
    evidence.cases.push('complaint commits while cron waits: no completion, release or false notification');

    const second = await createOrder();
    const completingHeld=deferred(), completingRelease=deferred();
    const completion = prisma.$transaction(async(tx)=>{
      await tx.$queryRaw`SELECT "id" FROM "CustomOrder" WHERE "id"=${second.id}::uuid FOR UPDATE`;
      await tx.customOrder.update({where:{id:second.id},data:{status:'COMPLETED'}});
      completingHeld.resolve(); await completingRelease.promise;
    },{timeout:15000});
    await completingHeld.promise;
    const reported = service.reportIssue(buyer.id,second.id,{issueType:'WRONG_ITEM',description:'Fixture',evidenceJson:{photos:['https://example.invalid/proof.jpg']}});
    const expectedRejection = assert.rejects(reported,/CUSTOM_ORDER_DISPUTE_WINDOW_CLOSED/);
    try { await waitForBlocked(); } finally { completingRelease.resolve(); }
    await completion; await expectedRejection;
    assert.equal(await prisma.customOrderIssue.count({where:{customOrderId:second.id}}),0);
    evidence.cases.push('completion commits while complaint waits: post-lock window check rejects late complaint');
    evidence.passed=true;
  } finally {
    if(prisma) await prisma.$disconnect(); if(pool) await pool.end();
    if(created) {
      assert(/^wiez_issue_race_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
      await admin.query(`DROP DATABASE "${database}"`); evidence.cleanupPassed=true;
    }
    await admin.end();
    await fs.writeFile(path.resolve(__dirname,'../docs/performance-reviews/custom-order-issue-race-postgres-2026-10-23.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error)=>{
  const required = String(error.message || '').match(/Argument `[^`]+` is missing|Invalid value for argument[^\n]*|Invalid value for argument[^\n]*/g);
  console.error(error.code || error.name || 'Custom-order issue race fixture failed', required || (error instanceof TypeError ? error.message : 'Fixture failed; no connection details logged'));
  process.exitCode=1;
});
