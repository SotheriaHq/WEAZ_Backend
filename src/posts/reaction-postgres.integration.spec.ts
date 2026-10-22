import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PostsService } from './posts.service';

const { Client, Pool } = require('pg');
const integration = process.env.RUN_REACTION_PG_TESTS === '1' ? describe : describe.skip;

integration('Post reaction concurrency on isolated local PostgreSQL', () => {
  let admin: any;
  let pool: any;
  let service: PostsService;
  let database: string;
  let postId: string;
  let failCounterWrite = false;
  let created = false;

  beforeAll(async () => {
    require('dotenv').config({ quiet: true });
    const source = new URL(process.env.DATABASE_URL ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) {
      throw new Error('Reaction integration tests require local PostgreSQL');
    }
    database = `wiez_reaction_race_${Date.now()}`;
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    const testUrl = new URL(source); testUrl.pathname = `/${database}`;
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    pool = new Pool({ connectionString: testUrl.toString(), max: 10, statement_timeout: 10000 });
    await pool.query(`
      CREATE TABLE "Post" ("_id" uuid PRIMARY KEY, "userId" uuid NOT NULL, "threadsCount" integer NOT NULL DEFAULT 0);
      CREATE TABLE "Thread" ("_id" uuid PRIMARY KEY, "postId" uuid REFERENCES "Post"("_id") ON DELETE CASCADE, "userId" uuid NOT NULL, UNIQUE("postId","userId"));
    `);
    const prisma = {
      post: { findUnique: async ({ where }: any) => (await pool.query('SELECT "_id" AS id,"userId","threadsCount" FROM "Post" WHERE "_id"=$1', [where.id])).rows[0] ?? null },
      $transaction: async (work: (tx: any) => Promise<unknown>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = {
            $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
              const statement = Prisma.sql(sql, ...values);
              return (await client.query(statement.text, statement.values)).rows;
            },
            thread: {
              findUnique: async ({ where }: any) => {
                const key = where.postId_userId;
                return (await client.query('SELECT "_id" AS id FROM "Thread" WHERE "postId"=$1 AND "userId"=$2', [key.postId, key.userId])).rows[0] ?? null;
              },
              create: async ({ data }: any) => client.query('INSERT INTO "Thread"("_id","postId","userId") VALUES($1,$2,$3)', [data.id, data.post.connect.id, data.user.connect.id]),
              delete: async ({ where }: any) => {
                const key = where.postId_userId;
                return client.query('DELETE FROM "Thread" WHERE "postId"=$1 AND "userId"=$2', [key.postId, key.userId]);
              },
            },
            post: { update: async ({ where, data }: any) => {
              if (failCounterWrite) { failCounterWrite = false; throw new Error('Injected counter failure'); }
              return (await client.query('UPDATE "Post" SET "threadsCount"=$2 WHERE "_id"=$1 RETURNING "_id" AS id,"userId","threadsCount"', [where.id, data.threadsCount])).rows[0];
            } },
          };
          const result = await work(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
    };
    service = new PostsService(prisma as any);
  }, 30000);

  beforeEach(async () => {
    postId = randomUUID();
    await pool.query('INSERT INTO "Post"("_id","userId") VALUES($1,$2)', [postId, randomUUID()]);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      // The generated database is the only deletion target; never use the source database name.
      if (created && /^wiez_reaction_race_\d+$/.test(database)) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  });

  it('retains all 20 different-user increments and serializes two same-user toggles', async () => {
    await Promise.all(Array.from({ length: 20 }, () => service.toggleThread(postId, randomUUID())));
    const user = randomUUID();
    await Promise.all([service.toggleThread(postId, user), service.toggleThread(postId, user)]);
    const actual = await pool.query('SELECT p."threadsCount",(SELECT COUNT(*)::int FROM "Thread" t WHERE t."postId"=p."_id") AS actual FROM "Post" p WHERE p."_id"=$1', [postId]);
    expect(actual.rows[0]).toEqual({ threadsCount: 20, actual: 20 });
  });

  it('rolls back the reaction insert if its counter update fails', async () => {
    failCounterWrite = true;
    await expect(service.toggleThread(postId, randomUUID())).rejects.toThrow('Injected counter failure');
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM "Thread" WHERE "postId"=$1', [postId])).rows[0].count).toBe(0);
    expect((await pool.query('SELECT "threadsCount" FROM "Post" WHERE "_id"=$1', [postId])).rows[0].threadsCount).toBe(0);
  });

  it('clamps removal at zero when a historical counter is under-counted', async () => {
    const user = randomUUID();
    await pool.query('INSERT INTO "Thread"("_id","postId","userId") VALUES($1,$2,$3)', [randomUUID(), postId, user]);
    await expect(service.toggleThread(postId, user)).resolves.toEqual({ threaded: false, threadsCount: 0 });
  });
});
