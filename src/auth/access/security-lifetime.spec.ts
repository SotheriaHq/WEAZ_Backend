import { createSecurityLease, securityRequestContext } from './security-request-context';
import { withSecurityTransaction, withSecurityWrite } from './transactional-enforcement';
import type { AdaptiveOperation } from './adaptive-access.service';
import type { PrismaService } from 'src/prisma/prisma.service';

jest.mock('./security-actor', () => ({ lockCurrentSecurityActor: jest.fn(async () => ({ user: { role: 'User' }, session: { riskState: 'NORMAL' } })) }));
const operation = (): AdaptiveOperation => ({
  actor: { id: 'actor', sid: 'session', authVersion: 1, role: 'User' },
  policy: { sensitivity: 'CRITICAL_CHANGE', action: 'account.security.change', scope: 'SELF' },
  method: 'POST', path: '/auth/change-password', route: '/auth/change-password', body: {},
  requiredAdminPermissions: [], operationDigest: 'fixture-digest', requestId: 'request',
  proof: `11111111-1111-4111-8111-111111111111.${'A'.repeat(43)}`,
});
const setup = () => {
  const tx = { securityStepUpChallenge: { updateMany: jest.fn(async () => ({ count: 1 })) } };
  const transaction = jest.fn(async (work: (client: unknown) => unknown) => work(tx));
  return { tx, transaction, prisma: { $transaction: transaction } as unknown as PrismaService };
};

describe('security request and transaction lifetime', () => {
  it('rejects work after the request closes before touching the database', async () => {
    const { prisma, transaction } = setup(); const request = createSecurityLease(); request.close();
    await expect(Promise.resolve().then(() => securityRequestContext.run({ operation: operation(), request },
      () => withSecurityWrite(prisma, async () => 'unexpected')))).rejects.toMatchObject({ status: 409 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects before commit when an in-flight request is aborted', async () => {
    const { prisma } = setup(); const request = createSecurityLease();
    await expect(securityRequestContext.run({ operation: operation(), request }, () =>
      withSecurityTransaction(prisma, async () => { request.close(); return 'must not commit'; })))
      .rejects.toMatchObject({ status: 409 });
  });

  it('keeps nested work inside the same live transaction', async () => {
    const { prisma, tx, transaction } = setup(); const request = createSecurityLease();
    await securityRequestContext.run({ operation: operation(), request }, () =>
      withSecurityTransaction(prisma, async (outer) => {
        expect(outer).toBe(tx);
        await withSecurityWrite(prisma, async (inner) => expect(inner).toBe(outer));
      }));
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rejects detached transaction work after success/failure (failure=%s)', async (fail) => {
    const { prisma, transaction } = setup(); const request = createSecurityLease();
    let detached: Promise<unknown> | undefined;
    const effect = jest.fn(async () => 'must not run');
    await securityRequestContext.run({ operation: operation(), request }, async () => {
      const attempt = withSecurityTransaction(prisma, async () => {
        detached = new Promise((resolve) => setImmediate(() => {
          Promise.resolve().then(() => withSecurityWrite(prisma, effect)).then(resolve, resolve);
        }));
        if (fail) throw new Error('fixture rollback');
      });
      if (fail) await expect(attempt).rejects.toThrow('fixture rollback');
      else await attempt;
    });
    expect(await detached).toMatchObject({ status: 409 });
    expect(effect).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary worker transactions without a human HTTP operation', async () => {
    const { prisma, transaction } = setup();
    await expect(withSecurityTransaction(prisma, async () => 'worker result')).resolves.toBe('worker result');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
