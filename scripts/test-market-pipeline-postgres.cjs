// Generated current-schema DDL checks source compatibility, NOT migration guards.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const { runPipelineFixture } = require('./lib/market-pipeline-fixture.cjs');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname), 'Loopback PostgreSQL required');
  const name = 'aru_market_pipeline_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source), target = new URL(source);
  adminUrl.pathname='/postgres'; target.pathname='/'+name;
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 10000 });
  const db = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10000 });
  let created=false,connected=false,prisma;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "'+name+'"'); created=true;
    await db.connect(); connected=true;
    await db.query("SET statement_timeout='60s'; SET lock_timeout='1s'; SET timezone='UTC'; CREATE EXTENSION IF NOT EXISTS pg_trgm");
    const generated = spawnSync(process.execPath,[path.join(__dirname,'../node_modules/prisma/build/index.js'),
      'migrate','diff','--from-empty','--to-schema','prisma/schema.prisma','--script'],
    { cwd:path.join(__dirname,'..'), env:{...process.env,DATABASE_URL:target.toString()}, encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024 });
    assert.equal(generated.status,0,'Current schema DDL generation failed');
    assert(generated.stdout.includes('CREATE TABLE "Product"'),'Expected actual current schema');
    await db.query(generated.stdout);
    console.log('SETUP current Prisma schema applied to guarded disposable database (migration guards not claimed)');
    prisma=new PrismaClient({adapter:new PrismaPg({connectionString:withUtcDatabaseUrl(target.toString())}),log:[{level:'query',emit:'event'}]});
    let queryCount=0,controlCount=0;
    // Statement heads are kept so a failed query budget can name each statement.
    const statementHeads=[];
    prisma.$on('query',event=>{queryCount++;statementHeads.push(event.query.trimStart().replace(/\s+/g,' ').slice(0,140));if(/^(?:BEGIN|COMMIT|ROLLBACK|SET\b|SELECT\s+set_config\b)/i.test(event.query.trimStart()))controlCount++;});
    const result=await runPipelineFixture({db,prisma,queryCount:()=>queryCount,queryStats:()=>({total:queryCount,controls:controlCount,statementsSince:from=>statementHeads.slice(from)}),now:new Date('2026-11-21T12:00:00.000Z')});
    console.log(`PASS ${result.checks} actual PostgreSQL pipeline source/transition proofs; ${result.plans} EXPLAIN executions`);
  } finally {
    try {
      try { if(prisma) await prisma.$disconnect(); }
      finally { if(connected) await db.end(); }
    } finally {
      try {
        if(created){
          assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(name));
          assert.equal(target.pathname,'/'+name);
          await admin.query('DROP DATABASE "'+name+'"');
          const remaining=await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name]);
          assert.equal(remaining.rowCount,0,'Owned disposable database removed');
          console.log('CLEANUP PASS owned disposable database dropped and absence verified');
        }
      } finally { await admin.end(); }
    }
  }
}
main().catch(error=>{console.error(error.name+': '+error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]'));console.error(String(error.stack??'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,8).join('\n'));process.exitCode=1;});
