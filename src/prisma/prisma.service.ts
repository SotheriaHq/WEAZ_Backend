import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { withUtcDatabaseUrl } from './database-connection';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const datasourceUrl = process.env.DATABASE_URL;

    if (!datasourceUrl) {
      throw new Error('DATABASE_URL is required to initialize PrismaClient.');
    }

    const pool = new Pool({ connectionString: withUtcDatabaseUrl(datasourceUrl) });
    const adapter = new PrismaPg(pool);

    const enableQueryLogs =
      String(process.env.PRISMA_LOG_QUERIES || '')
        .trim()
        .toLowerCase() === 'true';

    super({
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

    if (enableQueryLogs) {
      const slowMs = Math.max(
        0,
        Number(process.env.PRISMA_SLOW_QUERY_MS || 200) || 200,
      );
      this.$on('query' as any, (e: any) => {
        if (typeof e?.duration === 'number' && e.duration >= slowMs) {
          this.logger.warn(
            JSON.stringify({
              slowQueryMs: e.duration,
              model: e.target,
            }),
          );
        }
      });
    }
  }

  async onModuleInit() {
    await this.$connect();
    const rows = await this.$queryRaw<Array<{ timezone: string }>>`
      SELECT current_setting('TimeZone') AS timezone
    `;
    if (rows[0]?.timezone !== 'UTC') {
      throw new Error('Database connections must use UTC.');
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
