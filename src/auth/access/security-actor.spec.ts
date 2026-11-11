import { randomUUID } from 'node:crypto';
import { lockCurrentSecurityActor } from './security-actor';

describe('Studio parent challenge admission', () => {
  const actor = { id: randomUUID(), sid: randomUUID(), role: 'User', authVersion: 1 };
  function fixture() {
    const parentId = randomUUID();
    const child = { id: actor.sid, parentSessionId: parentId, riskState: 'NORMAL' };
    const parent = { id: parentId, riskState: 'CHALLENGE' };
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: actor.id }]),
      user: { findUnique: jest.fn().mockResolvedValue({ ...actor, status: 'ACTIVE', mustResetPassword: false }) },
      refreshToken: { findFirst: jest.fn().mockResolvedValueOnce(child).mockResolvedValueOnce(parent) } } as any;
    return { tx, child, parent };
  }
  it('uses one server timestamp so strict client lifetime parsing survives a ticking clock', async () => {
    const f = fixture(); let clock = 1_799_999_999_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock++);
    try {
      await expect(lockCurrentSecurityActor(f.tx, actor)).rejects.toMatchObject({ status: 428 });
      // Retry with another fixture to inspect the actual wire envelope.
      try { await lockCurrentSecurityActor(fixture().tx, actor); throw new Error('Expected parent challenge'); }
      catch (error: any) {
        const body = error.getResponse();
        expect(body.code).toBe('PARENT_SESSION_VERIFICATION_REQUIRED');
        expect(Date.parse(body.expiresAt) - Date.parse(body.serverNow)).toBe(300_000);
        expect(body.challengeId).toBeUndefined();
      }
    } finally { now.mockRestore(); }
  });
  it('does not let a missing parent become a new enrollment challenge', async () => {
    const f = fixture(); f.tx.refreshToken.findFirst.mockReset().mockResolvedValueOnce(f.child).mockResolvedValueOnce(null);
    await expect(lockCurrentSecurityActor(f.tx, actor)).rejects.toMatchObject({ status: 401 });
  });
});
