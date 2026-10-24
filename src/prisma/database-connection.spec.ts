import { withUtcDatabaseUrl } from './database-connection';

describe('UTC database connections', () => {
  const previousOptions = process.env.PGOPTIONS;
  afterEach(() => {
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
  });

  it('preserves connection settings and makes UTC the final startup override', () => {
    const source = new URL('postgresql://user:password@localhost/test?sslmode=require');
    source.searchParams.set('options', '-c statement_timeout=9000 -c timezone=Africa/Lagos');
    const result = new URL(withUtcDatabaseUrl(source.toString()));
    expect(result.searchParams.get('sslmode')).toBe('require');
    expect(result.searchParams.get('options')).toBe(
      '-c statement_timeout=9000 -c timezone=Africa/Lagos -c timezone=UTC',
    );
  });

  it('preserves PGOPTIONS when the URL has no options', () => {
    process.env.PGOPTIONS = '-c lock_timeout=5000';
    expect(new URL(withUtcDatabaseUrl('postgresql://localhost/test')).searchParams.get('options'))
      .toBe('-c lock_timeout=5000 -c timezone=UTC');
  });

  it('rejects invalid inputs without echoing connection secrets', () => {
    expect(() => withUtcDatabaseUrl('private-password')).toThrow(
      'DATABASE_URL must be a PostgreSQL connection URL.',
    );
    expect(() => withUtcDatabaseUrl('https://user:password@example.com')).toThrow(
      'DATABASE_URL must use PostgreSQL.',
    );
  });
});
