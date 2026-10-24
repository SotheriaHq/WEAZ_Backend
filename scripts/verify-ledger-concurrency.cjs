// Generated Prisma and actual LedgerService in a disposable PostgreSQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { LedgerService } = require('../src/finance/ledger.service');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_ledger_race_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`; testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false, prisma;
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  const waitForBlocked = async () => {
    for (let i=0;i<500;i++) {
      const result = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`, [database]);
      if (result.rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw Error('Expected competing ledger writer to wait for the database lock');
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
    const queries=[];
    prisma = new PrismaClient({adapter:new PrismaPg({ connectionString:testUrl.toString(), max:10 }),log:[{emit:'event',level:'query'}]});
    prisma.$on('query',event => queries.push(event.query));
    const ledger = new LedgerService(prisma);
    const params = (key, amount=1, reverse=false, prefix='shared') => ({
      idempotencyKey:key,type:'PAYMENT_RECEIVED',description:'Concurrency fixture',totalAmount:amount,currency:'NGN',
      lines:(reverse ? ['B','A'] : ['A','B']).map(code => ({
        code:`${prefix}:${code}`,name:code,type:'ASSET',subType:'FIXTURE',isSystemAccount:true,
        direction:code==='A' ? 'DEBIT' : 'CREDIT',amount,
      })),
    });
    const post = input => prisma.$transaction(tx => ledger.postTransaction(tx,input),{timeout:20000,maxWait:20000,isolationLevel:'ReadCommitted'});

    const held=deferred(),release=deferred();
    const first=prisma.$transaction(async tx => {
      const result=await ledger.postTransaction(tx,params('same-key',7));
      held.resolve();await release.promise;return result;
    },{timeout:20000});
    await held.promise;
    const second=post(params('same-key',7));
    try { await waitForBlocked(); } finally { release.resolve(); }
    const [one,two]=await Promise.all([first,second]);
    assert.equal(one.id,two.id);assert.equal(two.entries.length,2);
    assert.equal(await prisma.ledgerTransaction.count(),1);
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'shared:A'}})).currentBalance.toFixed(2),'7.00');
    evidence.cases.push('competing duplicate key waits, replays complete winner and posts once');

    await assert.rejects(post(params('same-key',8)),/LEDGER_IDEMPOTENCY_CONFLICT/);
    assert.equal(await prisma.ledgerEntry.count(),2);
    evidence.cases.push('same key with a different amount fails without extra entries');

    await Promise.all(Array.from({length:30},(_,i) => post(params(`cold:${i}`,1,i%2===0,'cold'))));
    assert.equal(await prisma.ledgerAccount.count({where:{code:{startsWith:'cold:'}}}),2);
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'cold:A'}})).currentBalance.toFixed(2),'30.00');
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'cold:B'}})).currentBalance.toFixed(2),'-30.00');
    assert.equal(await prisma.ledgerEntry.count({where:{account:{code:{startsWith:'cold:'}}}}),60);
    evidence.cases.push('thirty cold-account postings with opposite line order retain every cent without deadlock');

    const rollbackBefore=await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'cold:A'}});
    await assert.rejects(prisma.$transaction(async tx => {
      await ledger.postTransaction(tx,params('rollback',11,false,'cold'));
      throw Error('Fixture rollback');
    }),/Fixture rollback/);
    assert.equal(await prisma.ledgerTransaction.count({where:{idempotencyKey:'rollback'}}),0);
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'cold:A'}})).currentBalance.toFixed(2),rollbackBefore.currentBalance.toFixed(2));
    evidence.cases.push('outer transaction rollback removes claim, entries and balance changes together');

    await prisma.ledgerAccount.update({where:{code:'cold:A'},data:{currentBalance:new Prisma.Decimal('999999999999999.90')}});
    await post(params('precision',0.01,false,'cold'));
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'cold:A'}})).currentBalance.toFixed(2),'999999999999999.91');
    evidence.cases.push('large stored decimal balance retains a one-cent increment');

    const repeated=params('repeated',3,false,'cold');
    repeated.lines=[{...repeated.lines[0],amount:1},{...repeated.lines[0],amount:2},repeated.lines[1]];
    const repeatedResult=await post(repeated);
    const snapshots=repeatedResult.entries.filter(entry => entry.account.code==='cold:A').map(entry => entry.balanceAfter.toFixed(2)).sort();
    assert.deepEqual(snapshots,['1000000000000000.91','1000000000000002.91']);
    evidence.cases.push('repeated account lines preserve each intermediate balance snapshot');

    for (const amount of [-1,NaN,Infinity]) await assert.rejects(post(params(`invalid:${String(amount)}`,amount)),/LEDGER_INVALID_AMOUNT/);
    const unbalanced=params('unbalanced');unbalanced.lines[1].amount=2;
    await assert.rejects(post(unbalanced),/LEDGER_UNBALANCED_TRANSACTION/);
    const mismatch=params('definition-mismatch',1,false,'cold');mismatch.lines[0].type='LIABILITY';
    await assert.rejects(post(mismatch),/LEDGER_ACCOUNT_DEFINITION_MISMATCH/);
    assert.equal(await prisma.ledgerTransaction.count({where:{idempotencyKey:{in:['invalid:-1','invalid:NaN','invalid:Infinity','unbalanced','definition-mismatch']}}}),0);
    evidence.cases.push('non-finite, negative, unbalanced and mismatched-account input rolls back');

    await post(params('warm-up',1,false,'bounded'));
    queries.length=0;
    const many=params('bounded-lines',20,false,'bounded');
    many.lines=Array.from({length:20},()=>params('unused').lines).flat().map(line=>({...line,code:line.code.replace('shared:','bounded:')}));
    await post(many);
    const accountReads=queries.filter(query=>/SELECT[\s\S]*FROM\s+"(?:public"\.")?LedgerAccount"/i.test(query));
    // findMany + ordered lock; returned transaction may hydrate accounts once.
    assert(accountReads.length<=3,`Forty ledger lines caused ${accountReads.length} account reads`);
    assert.equal((await prisma.ledgerAccount.findUniqueOrThrow({where:{code:'bounded:A'}})).currentBalance.toFixed(2),'21.00');
    evidence.cases.push(`forty lines use bounded account reads (${accountReads.length}) and batch entries/balances`);
    evidence.passed=true;
  } finally {
    if(prisma)await prisma.$disconnect();
    if(created){
      assert(/^wiez_ledger_race_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
      await admin.query(`DROP DATABASE "${database}"`);evidence.cleanupPassed=true;
    }
    await admin.end();
    await fs.writeFile(path.resolve(__dirname,'../docs/performance-reviews/ledger-concurrency-postgres-2026-10-23.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(error=>{console.error(error instanceof assert.AssertionError || error instanceof TypeError ? error.message : error.code || error.name || 'Ledger fixture failed');process.exitCode=1;});
