#!/usr/bin/env node
/** Bounded, resumable audit. Writes require --apply; never changes reaction/comment rows. */
const { Pool } = require('pg');

const liveComments = (types) => `(SELECT COUNT(*)::int FROM "CommentV2" c WHERE c."targetId"=t."_id" AND c."targetType" IN (${types.map((type) => `'${type}'`).join(',')}) AND c."deletedAt" IS NULL)`;
const scopes = {
  collections: { table: 'Collection', counters: {
    threadsCount: `(SELECT COUNT(*)::int FROM "CollectionReaction" r WHERE r."collectionId"=t."_id" AND r."type"='THREAD')`,
    dislikesCount: `(SELECT COUNT(*)::int FROM "CollectionReaction" r WHERE r."collectionId"=t."_id" AND r."type"='DISLIKE')`,
    commentsCount: liveComments(['COLLECTION', 'DESIGN']),
  } },
  media: { table: 'CollectionMedia', counters: {
    threadsCount: `(SELECT COUNT(*)::int FROM "CollectionMediaReaction" r WHERE r."collectionMediaId"=t."_id" AND r."type"='THREAD')`,
    commentsCount: liveComments(['COLLECTION_MEDIA']),
  } },
  posts: { table: 'Post', counters: {
    threadsCount: `(SELECT COUNT(*)::int FROM "Thread" r WHERE r."postId"=t."_id")`,
    commentsCount: liveComments(['POST']),
  } },
  comments: { table: 'CommentV2', counters: {
    threadsCount: `(SELECT COUNT(*)::int FROM "CommentV2Thread" r WHERE r."commentId"=t."_id")`,
    replyCount: `(SELECT COUNT(*)::int FROM "CommentV2" c WHERE c."parentId"=t."_id" AND c."deletedAt" IS NULL)`,
  } },
};

function parseArgs(args) {
  const result = { apply: false, help: false, scope: 'all', batchSize: 100, maxRecords: 2000, after: null };
  for (const argument of args) {
    if (argument === '--apply') result.apply = true;
    else if (argument === '--help') result.help = true;
    else if (argument.startsWith('--scope=')) result.scope = argument.slice(8);
    else if (argument.startsWith('--batch-size=')) result.batchSize = Number(argument.slice(13));
    else if (argument.startsWith('--max-records=')) result.maxRecords = Number(argument.slice(14));
    else if (argument.startsWith('--after=')) result.after = argument.slice(8);
    else throw new Error(`Unknown option: ${argument.split('=')[0]}`);
  }
  if (result.scope !== 'all' && !Object.hasOwn(scopes, result.scope)) throw new Error('Invalid scope');
  if (!Number.isInteger(result.batchSize) || result.batchSize < 1 || result.batchSize > 500) throw new Error('batch-size must be 1..500');
  if (!Number.isInteger(result.maxRecords) || result.maxRecords < 1 || result.maxRecords > 100000) throw new Error('max-records must be 1..100000');
  if (result.after && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.after) || result.scope === 'all')) {
    throw new Error('after requires a UUID and one explicit scope');
  }
  return result;
}

function auditSql(scope) {
  const definition = scopes[scope];
  if (!definition) throw new Error('Invalid scope');
  const entries = Object.entries(definition.counters);
  const current = entries.map(([column]) => `'${column}',t."${column}"`).join(',');
  const expected = entries.map(([column, expression]) => `'${column}',${expression}`).join(',');
  return `SELECT t."_id" AS id,jsonb_build_object(${current}) AS current,jsonb_build_object(${expected}) AS expected FROM "${definition.table}" t WHERE t."_id"=ANY($1::uuid[]) ORDER BY t."_id"`;
}

async function auditBatch(client, scope, ids, apply) {
  const definition = scopes[scope];
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (apply) {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='3s'");
        // Count in the following statement, after these locks: a pre-lock snapshot can be stale.
        await client.query(`SELECT "_id" FROM "${definition.table}" WHERE "_id"=ANY($1::uuid[]) ORDER BY "_id" FOR UPDATE`, [ids]);
      }
      const { rows } = await client.query(auditSql(scope), [ids]);
      const drift = rows.filter((row) => Object.entries(row.expected).some(([key, value]) => value !== row.current[key]));
      if (apply) {
        const columns = Object.keys(definition.counters);
        for (const row of drift) {
          await client.query(`UPDATE "${definition.table}" SET ${columns.map((column, index) => `"${column}"=$${index + 2}`).join(',')} WHERE "_id"=$1::uuid`, [row.id, ...columns.map((column) => row.expected[column])]);
        }
        await client.query('COMMIT');
      }
      return { scanned: rows.length, drift };
    } catch (error) {
      if (apply) await client.query('ROLLBACK');
      if (!apply || !['40P01', '40001', '55P03'].includes(error.code) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Dry run: node scripts/reconcile-reaction-counters.cjs [--scope=collections|media|posts|comments] [--batch-size=100] [--max-records=2000] [--after=UUID]\nAdd --apply only after reviewing the dry-run results. Install the atomic-counter release before applying reconciliation.\n');
    return;
  }
  require('dotenv').config({ quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 30000, application_name: 'wiez-reaction-counter-audit' });
  const requestedScopes = options.scope === 'all' ? Object.keys(scopes) : [options.scope];
  const report = { mode: options.apply ? 'apply' : 'dry-run', complete: false, requestedScopes, scanned: 0, mismatches: 0, scopes: [], examples: [] };
  try {
    const client = await pool.connect();
    try {
      for (const scope of requestedScopes) {
        let cursor = options.after;
        let scanned = 0;
        let mismatches = 0;
        let complete = false;
        while (report.scanned < options.maxRecords) {
          const take = Math.min(options.batchSize, options.maxRecords - report.scanned);
          const found = await client.query(`SELECT "_id" AS id FROM "${scopes[scope].table}" WHERE ($1::uuid IS NULL OR "_id">$1::uuid) ORDER BY "_id" LIMIT $2`, [cursor, take]);
          if (!found.rows.length) { complete = true; break; }
          const ids = found.rows.map((row) => row.id);
          const batch = await auditBatch(client, scope, ids, options.apply);
          // Advance the scan budget even if a row was concurrently removed.
          report.scanned += ids.length;
          scanned += batch.scanned;
          mismatches += batch.drift.length;
          report.mismatches += batch.drift.length;
          report.examples.push(...batch.drift.slice(0, Math.max(0, 20 - report.examples.length)).map((row) => ({ scope, ...row })));
          cursor = ids[ids.length - 1];
          if (ids.length < take) { complete = true; break; }
        }
        report.scopes.push({ scope, scanned, mismatches, complete, nextCursor: complete ? null : cursor });
        if (report.scanned >= options.maxRecords) break;
      }
    } finally { client.release(); }
    report.complete = report.scopes.length === requestedScopes.length && report.scopes.every((scope) => scope.complete);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await pool.end(); }
}

module.exports = { parseArgs, auditSql, auditBatch };
if (require.main === module) main().catch((error) => {
  // Database errors can contain connection details; expose only the stable code.
  process.stderr.write(`Reaction-counter audit failed: ${error.code ?? error.name ?? 'Error'}\n`);
  process.exitCode = 1;
});
