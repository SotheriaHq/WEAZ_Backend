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
      for (let attempt = 0; ; attempt++) {
        let entered = false;
        try {
          return await this.transaction(read, options, () => {
            entered = true;
          });
        } catch (error) {
          // A pooled connection the server already ended (transaction_timeout,
          // terminate, restart) fails at BEGIN, before any read ran. One retry
          // on a fresh connection is safe and stays inside the same deadline.
          const budgetLeft =
            options.deadline === undefined ||
            options.deadline - performance.now() > MARKET_READ_RETRY_MIN_MS;
          if (
            !entered &&
            attempt === 0 &&
            budgetLeft &&
            isEndedConnection(error)
          )
            continue;
          throw error;
        }
      }
    } catch (error) {
      throw mapMarketReadError(error, options);
    } finally {
      this.active--;
    }
  }

  private async transaction<T>(
    read: (tx: Prisma.TransactionClient) => Promise<T>,
    options: MarketReadOptions,
    onEntered: () => void,
  ): Promise<T> {
    const remaining = () =>
      options.deadline === undefined
        ? MARKET_CATALOG_TRANSACTION_MS
        : Math.max(1, Math.floor(options.deadline - performance.now()));
    const result = await this.prisma.$transaction(
      async (tx) => {
        onEntered();
        assertMarketReadDeadline(options);
        // One round trip sets read-only mode and every limit. A local
        // transaction_read_only=on is PostgreSQL's SET TRANSACTION READ ONLY;
        // readers that depend on it check it with current_setting.
        if (options.deadline === undefined) {
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('transaction_read_only','on',true),set_config('statement_timeout','1500ms',true),set_config('lock_timeout','250ms',true)`,
          );
        } else {
          const transactionMs = remaining(),
            statementMs = Math.min(250, transactionMs);
          // PostgreSQL 17+ terminates the transaction's connection at the
          // absolute budget. No Promise.race leaves database work abandoned.
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('transaction_read_only','on',true),set_config('statement_timeout',${String(statementMs)}::text,true),set_config('lock_timeout',${String(Math.min(250, transactionMs))}::text,true),set_config('transaction_timeout',${String(transactionMs)}::text,true)`,
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
  }
}

/** Retrying at less than this remaining budget cannot finish a read. */
export const MARKET_READ_RETRY_MIN_MS = 25;
// Server-ended sessions: admin/crash/cannot-connect shutdown and connection
// exceptions. Lock, statement and pool-wait timeouts are deliberately absent.
const ENDED_CONNECTION_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08003',
  '08006',
]);

/** True only for a connection the server already closed, never a timeout. */
export function isEndedConnection(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return (
      error.code === 'P1017' ||
      ENDED_CONNECTION_CODES.has(String(databaseErrorCode(error.meta)))
    );
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  // pg's fixed text for a socket the server closed; it carries no SQL or data.
  return (
    (typeof code === 'string' && ENDED_CONNECTION_CODES.has(code)) ||
    error.message === 'Connection terminated unexpectedly'
  );
}

function mapMarketReadError(
  error: unknown,
  options: MarketReadOptions,
): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode = databaseErrorCode(error.meta);
    if (
      options.deadline !== undefined &&
      error.code === 'P2010' &&
      databaseCode === '42704'
    )
      return new ServiceUnavailableException({
        code: 'CATALOGUE_DATABASE_CAPABILITY_REQUIRED',
        message: 'The catalogue is updating. Please try again shortly.',
      });
    if (
      ['P1017', 'P2024', 'P2028', 'P2037'].includes(error.code) ||
      (error.code === 'P2010' &&
        ['57014', '55P03', '53300', '25P04'].includes(String(databaseCode)))
    )
      return new ServiceUnavailableException({
        code: 'CATALOGUE_READ_LIMIT',
        message: 'The catalogue is busy. Please try again shortly.',
      });
  }
  // A connection ended by the server is a transient capacity condition.
  if (isEndedConnection(error))
    return new ServiceUnavailableException({
      code: 'CATALOGUE_READ_LIMIT',
      message: 'The catalogue is busy. Please try again shortly.',
    });
  return error;
}
