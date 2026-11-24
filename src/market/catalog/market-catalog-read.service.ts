import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A process-local bulkhead; fleet-wide admission belongs at the ingress. */
export const MARKET_CATALOG_CONCURRENT_READS = 4;
export const MARKET_CATALOG_TRANSACTION_MS = 2000;

export interface MarketReadOptions {
  /** Absolute monotonic clock, shared across capture and final authorization. */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
}

export function assertMarketReadDeadline(
  options: MarketReadOptions = {},
): void {
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new RangeError('Invalid catalogue deadline');
  if (
    options.signal?.aborted ||
    (options.deadline !== undefined && performance.now() >= options.deadline)
  )
    throw new ServiceUnavailableException({
      code: 'CATALOGUE_READ_LIMIT',
      message: 'The catalogue is busy. Please try again shortly.',
    });
}

/** The bulkhead refused the read before any transaction or connection request. */
export class MarketCatalogAdmissionException extends ServiceUnavailableException {
  constructor() {
    super({
      code: 'CATALOGUE_BUSY',
      message: 'The catalogue is busy. Please try again shortly.',
    });
  }
}

function databaseErrorCode(meta: Record<string, unknown> | undefined): unknown {
  if (typeof meta?.code === 'string') return meta.code;
  // Prisma's PostgreSQL driver adapter retains SQLSTATE in a structured cause.
  // Do not infer a database code from error messages containing private SQL.
  const adapter = meta?.driverAdapterError;
  if (!adapter || typeof adapter !== 'object' || !('cause' in adapter))
    return undefined;
  const cause = adapter.cause;
  return cause && typeof cause === 'object' && 'originalCode' in cause
    ? cause.originalCode
    : undefined;
}

@Injectable()
export class MarketCatalogReadService {
  private active = 0;

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    read: (tx: Prisma.TransactionClient) => Promise<T>,
    options: MarketReadOptions = {},
  ): Promise<T> {
    assertMarketReadDeadline(options);
    // Reject instead of accumulating a second, unbounded application queue.
    if (this.active >= MARKET_CATALOG_CONCURRENT_READS)
      throw new MarketCatalogAdmissionException();
    this.active++;
    try {
      const remaining = () =>
        options.deadline === undefined
          ? MARKET_CATALOG_TRANSACTION_MS
          : Math.max(1, Math.floor(options.deadline - performance.now()));
      const result = await this.prisma.$transaction(
        async (tx) => {
          assertMarketReadDeadline(options);
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          if (options.deadline === undefined) {
            await tx.$executeRaw`SET LOCAL statement_timeout='1500ms'`;
            await tx.$executeRaw`SET LOCAL lock_timeout='250ms'`;
          } else {
            assertMarketReadDeadline(options);
            const transactionMs = remaining(),
              statementMs = Math.min(250, transactionMs);
            // PostgreSQL 17+ terminates the transaction's connection at the
            // absolute budget. No Promise.race leaves database work abandoned.
            await tx.$queryRaw(
              Prisma.sql`SELECT set_config('statement_timeout',${String(statementMs)}::text,true),set_config('lock_timeout',${String(Math.min(250, transactionMs))}::text,true),set_config('transaction_timeout',${String(transactionMs)}::text,true)`,
            );
          }
          assertMarketReadDeadline(options);
          const value = await read(tx);
          assertMarketReadDeadline(options);
          return value;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: Math.min(250, remaining()),
          timeout: Math.min(MARKET_CATALOG_TRANSACTION_MS, remaining()),
        },
      );
      assertMarketReadDeadline(options);
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        const databaseCode = databaseErrorCode(error.meta);
        if (
          options.deadline !== undefined &&
          error.code === 'P2010' &&
          databaseCode === '42704'
        )
          throw new ServiceUnavailableException({
            code: 'CATALOGUE_DATABASE_CAPABILITY_REQUIRED',
            message: 'The catalogue is updating. Please try again shortly.',
          });
        if (
          ['P1017', 'P2024', 'P2028', 'P2037'].includes(error.code) ||
          (error.code === 'P2010' &&
            ['57014', '55P03', '53300', '25P04'].includes(String(databaseCode)))
        )
          throw new ServiceUnavailableException({
            code: 'CATALOGUE_READ_LIMIT',
            message: 'The catalogue is busy. Please try again shortly.',
          });
      }
      throw error;
    } finally {
      this.active--;
    }
  }
}
