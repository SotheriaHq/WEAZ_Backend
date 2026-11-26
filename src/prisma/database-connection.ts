import { Pool, PoolConfig } from 'pg';

/**
 * A pg pool whose clients can never raise an unhandled 'error' event.
 *
 * The server can end a session at any time: PostgreSQL 17 `transaction_timeout`
 * terminates the whole session, as do an administrator terminate and a database
 * restart. pg then emits 'error' on that client, even while it is checked out.
 * The Prisma adapter listens only while a transaction is open and between
 * cleanup and release there is a window with no listener, where the event
 * would crash the process. Every client therefore gets a permanent listener the
 * moment it connects; the failed query still rejects normally to its caller.
 */
export function createResilientPgPool(
  connectionString: string,
  onError: (error: Error) => void,
  config: PoolConfig = {},
): Pool {
  const pool = new Pool({
    ...config,
    connectionString: withUtcDatabaseUrl(connectionString),
  });
  pool.on('error', onError);
  pool.on('connect', (client) => client.on('error', onError));
  return pool;
}

/** Prisma DateTime columns store UTC timestamp values without a time-zone suffix. */
export function withUtcDatabaseUrl(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  // The URL's options override pg.Pool options. Preserve other startup settings,
  // then apply UTC last so a URL or PGOPTIONS cannot silently restore local time.
  const options =
    url.searchParams.get('options') || process.env.PGOPTIONS || '';
  url.searchParams.set('options', `${options.trim()} -c timezone=UTC`.trim());
  return url.toString();
}
