import { randomUUID } from 'node:crypto';
import { draftListCursor, draftListPage } from './draft-list-query';

describe('bounded owner draft pages', () => {
  const owner = randomUUID(), id = randomUUID(), createdAt = new Date('2026-11-10T00:00:00.000Z');
  it('uses a deterministic createdAt/id keyset and requests only one cover per row', () => {
    const cursor = draftListCursor(owner, { id, createdAt });
    const { query, limit } = draftListPage(owner, { cursor, limit: '100', domain: 'DESIGN' });
    expect(limit).toBe(100); expect(query.text).toContain('LEFT JOIN LATERAL');
    expect(query.text).toContain('NOT EXISTS'); expect(query.text).toContain('draft."createdAt", draft."_id"');
    expect(query.values).toEqual(expect.arrayContaining([owner, 'DESIGN', createdAt, id, 101]));
    expect(query.text).not.toContain(owner); expect(query.text).not.toContain('OFFSET');
  });
  it.each([0, 101, -1, 1.5, NaN, Infinity, '10 OR1=1', '1e2', '0001', ''])('rejects invalid page size %s before any database work', limit => {
    expect(() => draftListPage(owner, { limit })).toThrow('page size');
  });
  it('binds cursors to the account, rejects malformed dates and validates size/format', () => {
    const cursor = draftListCursor(owner, { id, createdAt });
    expect(() => draftListPage(randomUUID(), { cursor })).toThrow('cursor');
    for (const value of ['', 'bad.cursor', 'A'.repeat(513), Buffer.from(JSON.stringify({ v: 1, u: owner, i: id, t: 'invalid' })).toString('base64url')])
      expect(() => draftListPage(owner, { cursor: value })).toThrow('cursor');
  });
});
