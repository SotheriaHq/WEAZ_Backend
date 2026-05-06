import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export type ScriptPrismaClient = {
  prisma: PrismaClient;
  pool: Pool;
  disconnect: () => Promise<void>;
};

export function createScriptPrismaClient(): ScriptPrismaClient {
  const datasourceUrl = process.env.DATABASE_URL;

  if (!datasourceUrl) {
    throw new Error(
      'DATABASE_URL is required to initialize PrismaClient for scripts.',
    );
  }

  const pool = new Pool({ connectionString: datasourceUrl });
  const adapter = new PrismaPg(pool);
  const enableQueryLogs =
    String(process.env.PRISMA_LOG_QUERIES || '')
      .trim()
      .toLowerCase() === 'true';

  const prisma = new PrismaClient({
    adapter,
    log: enableQueryLogs
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'error' },
          { emit: 'stdout', level: 'warn' },
        ]
      : [
          { emit: 'stdout', level: 'error' },
          { emit: 'stdout', level: 'warn' },
        ],
  });

  return {
    prisma,
    pool,
    async disconnect() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
