import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { createResilientPgPool } from '../../prisma/database-connection';
import { createMarketPlanNames } from './market-read-plans';

/** One connection per admitted Market read; a read never waits for writers. */
export const MARKET_READ_CONNECTIONS = 4;

/**
 * Every session is read-only with short limits, so a single statement needs no
 * transaction to be safe. Transactions on this pool set their own limits.
 */
export const MARKET_READ_SESSION_OPTIONS =
  '-c default_transaction_read_only=on -c statement_timeout=250 -c lock_timeout=250 -c idle_in_transaction_session_timeout=5000';

export function marketReadDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get('options') || process.env.PGOPTIONS;
  url.searchParams.set(
    'options',
    `${options ?? ''} ${MARKET_READ_SESSION_OPTIONS}`.trim(),
  );
  return url.toString();
}

export function createMarketReadPool(
  databaseUrl: string,
  onError: (error: Error) => void,
): Pool {
  return createResilientPgPool(marketReadDatabaseUrl(databaseUrl), onError, {
    max: MARKET_READ_CONNECTIONS,
    idleTimeoutMillis: 60_000,
    // A recycled session drops plans made before a schema change.
    maxLifetimeSeconds: 1_800,
  });
}

export function createMarketReadAdapter(pool: Pool): PrismaPg {
  return new PrismaPg(pool, {
    disposeExternalPool: true,
    statementNameGenerator: createMarketPlanNames(),
  });
}

/**
 * Public Market reads on their own small pool, with reusable plans. Kept apart
 * from the application pool so prepared plans live on four connections instead
 * of every one, and so a burst of reads cannot starve checkout or payments.
 * Connections open on first use and close when idle.
 */
@Injectable()
export class MarketReadPrismaService
  extends PrismaClient
  implements OnModuleDestroy
{
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl)
      throw new Error('DATABASE_URL is required to initialize Market reads.');
    const logger = new Logger('MarketReadConnection');
    super({
      adapter: createMarketReadAdapter(
        createMarketReadPool(databaseUrl, (error) =>
          logger.warn({
            event: 'market.read_connection_ended',
            code: (error as { code?: string }).code ?? null,
            message: error.message,
          }),
        ),
      ),
      log: [
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
