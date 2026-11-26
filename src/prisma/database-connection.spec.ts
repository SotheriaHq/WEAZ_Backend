import { EventEmitter } from 'node:events';
import {
  createResilientPgPool,
  withUtcDatabaseUrl,
} from './database-connection';

describe('resilient PostgreSQL pool', () => {
  const url = 'postgresql://user:password@localhost:5432/test';
  it('handles an error from a checked-out client instead of crashing', async () => {
    const onError = jest.fn();
    const pool = createResilientPgPool(url, onError);
    const client = new EventEmitter();
    pool.emit('connect', client);
    const ended = new Error('Connection terminated unexpectedly');
    // Without a listener, EventEmitter throws on an unhandled 'error' event.
    expect(() => client.emit('error', ended)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(ended);
    await pool.end();
  });
  it('handles an idle client error raised by the pool', async () => {
    const onError = jest.fn();
    const pool = createResilientPgPool(url, onError);
    const idle = new Error(
      'terminating connection due to administrator command',
    );
    expect(() => pool.emit('error', idle)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(idle);
    await pool.end();
  });
  it('keeps UTC as the session time zone', async () => {
    const pool = createResilientPgPool(url, jest.fn());
    const options = (
      pool as unknown as { options: { connectionString: string } }
    ).options.connectionString;
    expect(new URL(options).searchParams.get('options')).toContain(
      '-c timezone=UTC',
    );
    await pool.end();
  });
});

describe('UTC database connections', () => {
  const previousOptions = process.env.PGOPTIONS;
  afterEach(() => {
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
  });

  it('preserves connection settings and makes UTC the final startup override', () => {
    const source = new URL(
      'postgresql://user:password@localhost/test?sslmode=require',
    );
    source.searchParams.set(
      'options',
      '-c statement_timeout=9000 -c timezone=Africa/Lagos',
    );
    const result = new URL(withUtcDatabaseUrl(source.toString()));
    expect(result.searchParams.get('sslmode')).toBe('require');
    expect(result.searchParams.get('options')).toBe(
      '-c statement_timeout=9000 -c timezone=Africa/Lagos -c timezone=UTC',
    );
  });

  it('preserves PGOPTIONS when the URL has no options', () => {
    process.env.PGOPTIONS = '-c lock_timeout=5000';
    expect(
      new URL(
        withUtcDatabaseUrl('postgresql://localhost/test'),
      ).searchParams.get('options'),
    ).toBe('-c lock_timeout=5000 -c timezone=UTC');
  });

  it('rejects invalid inputs without echoing connection secrets', () => {
    expect(() => withUtcDatabaseUrl('private-password')).toThrow(
      'DATABASE_URL must be a PostgreSQL connection URL.',
    );
    expect(() =>
      withUtcDatabaseUrl('https://user:password@example.com'),
    ).toThrow('DATABASE_URL must use PostgreSQL.');
  });
});
