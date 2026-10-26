const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
require('dotenv').config({quiet:true});
async function main(){
  const source=new URL(process.env.DATABASE_URL||'');
  assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Loopback PostgreSQL required');
  const database=`wiez_queue_validation_${randomUUID().replaceAll('-','')}`;
  const adminUrl=new URL(source);adminUrl.pathname='/postgres';
  const testUrl=new URL(source);testUrl.pathname=`/${database}`;testUrl.searchParams.set('options','-c timezone=UTC');
  const admin=new Client({connectionString:adminUrl.toString()});
  const evidence={checkedAt:new Date().toISOString(),passed:false,cleanupPassed:false};
  let created=false;
  const run=(args,env,stdio='ignore')=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:path.resolve(__dirname,'..'),env,stdio,windowsHide:true});
    child.once('error',reject);child.once('close',resolve);
  });
  await admin.connect();
  try{
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const env={...process.env,DATABASE_URL:testUrl.toString(),QUEUE_TEST_DATABASE_URL:testUrl.toString(),THREADLY_PRISMA_SKIP_SEED:'true'};
    evidence.migrationExitCode=await run(['node_modules/prisma/build/index.js','migrate','deploy'],env);
    assert.equal(evidence.migrationExitCode,0,'Fresh queue schema must migrate');
    const report=path.resolve(__dirname,`../.tmp/${database}.json`);
    evidence.testExitCode=await run(['node_modules/jest/bin/jest.js','src/custom-orders/queue/custom-order-queue.integration.spec.ts','--runInBand','--json',`--outputFile=${report}`],env,'inherit');
    const result=JSON.parse(await fs.readFile(report,'utf8'));
    evidence.passedTests=result.numPassedTests;evidence.skippedTests=result.numPendingTests;
    evidence.testNames=result.testResults.flatMap(suite=>suite.assertionResults.map(test=>({name:test.title,status:test.status})));
    evidence.passed=evidence.testExitCode===0&&result.success&&result.numPassedTests>=4&&result.numPendingTests===0;
  }finally{
    if(created){
      assert(/^wiez_queue_validation_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
      await admin.query(`DROP DATABASE "${database}"`);evidence.cleanupPassed=true;
    }
    await admin.end();
    await fs.writeFile(path.resolve(__dirname,'../docs/performance-reviews/subscription-queue-postgres-2026-10-23.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));if(!evidence.passed)process.exitCode=1;
  }
}
main().catch(error=>{console.error(error instanceof assert.AssertionError?error.message:error.code||error.name);process.exitCode=1;});
