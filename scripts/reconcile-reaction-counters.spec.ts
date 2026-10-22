const { parseArgs, auditBatch } = require('./reconcile-reaction-counters.cjs');

describe('reaction-counter reconciliation safety', () => {
  it('defaults to a bounded read-only audit', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, batchSize: 100, maxRecords: 2000, scope: 'all' });
    expect(() => parseArgs(['--batch-size=501'])).toThrow();
    expect(() => parseArgs(['--max-records=0'])).toThrow();
    expect(() => parseArgs(['--scope=unexpected'])).toThrow();
    expect(() => parseArgs(['--after=00000000-0000-0000-0000-000000000001'])).toThrow();
    expect(() => parseArgs(['--scope=posts', '--after=not-a-uuid'])).toThrow();
  });

  it('never opens a write transaction during the default dry run', async () => {
    const query = jest.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: 'one', current: { threadsCount: 3 }, expected: { threadsCount: 1 } }] }));
    const result = await auditBatch({ query }, 'posts', ['one'], false);
    expect(result.drift).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT /);
  });

  it('takes target locks before the separate fresh count and updates only with explicit apply', async () => {
    const queries: string[] = [];
    const query = jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT t.') ? [{ id: 'one', current: { threadsCount: 3, commentsCount: 0 }, expected: { threadsCount: 1, commentsCount: 0 } }] : [] };
    });
    await auditBatch({ query }, 'posts', ['one'], true);
    const locked = queries.findIndex((sql) => sql.includes('FOR UPDATE'));
    const counted = queries.findIndex((sql) => sql.startsWith('SELECT t.'));
    const updated = queries.findIndex((sql) => sql.startsWith('UPDATE '));
    expect(locked).toBeGreaterThan(-1);
    expect(counted).toBeGreaterThan(locked);
    expect(updated).toBeGreaterThan(counted);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  it('rolls back an interrupted repair instead of leaving a partially repaired batch', async () => {
    const queries: string[] = [];
    const query = jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('UPDATE ')) throw Object.assign(new Error('connection interrupted'), { code: '08006' });
      return { rows: sql.startsWith('SELECT t.') ? [{ id: 'one', current: { threadsCount: 3 }, expected: { threadsCount: 1 } }] : [] };
    });
    await expect(auditBatch({ query }, 'posts', ['one'], true)).rejects.toMatchObject({ code: '08006' });
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });
});
