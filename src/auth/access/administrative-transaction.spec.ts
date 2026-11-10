import {
  securityRequestContext,
  createSecurityLease,
} from './security-request-context';
import {
  withSecurityTransaction,
  withSecurityWrite,
} from './transactional-enforcement';
import { lockCurrentSecurityActor } from './security-actor';
import type { AdaptiveOperation } from './adaptive-access.service';
import type { PrismaService } from 'src/prisma/prisma.service';

jest.mock('./security-actor', () => ({ lockCurrentSecurityActor: jest.fn() }));

describe('administrator command transaction boundary', () => {
  const operation = (): AdaptiveOperation => ({
    actor: { id: 'admin', sid: 'session', authVersion: 2, role: 'Admin' },
    policy: {
      scope: 'ADMIN',
      action: 'admin.write',
      sensitivity: 'SENSITIVE_READ',
    },
    method: 'POST',
    path: '/verification/physical/visit/proofs',
    route: '/verification/physical/:id/proofs',
    body: {},
    operationDigest: 'fixture',
    requestId: 'fixture',
    requiredAdminPermissions: ['verification.physical.decide'],
  });
  const setup = () => {
    const tx = {
      adminPermissionGrant: {
        findMany: jest.fn(async () => [
          { permissionCode: 'verification.physical.decide' },
        ]),
      },
      securityStepUpChallenge: { updateMany: jest.fn() },
    };
    const transaction = jest.fn(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    );
    const session = {
      riskState: 'NORMAL',
      strongAuthenticatedAt: new Date(),
      strongAuthVersion: 2,
    };
    (lockCurrentSecurityActor as jest.Mock).mockResolvedValue({ user: { role: 'Admin' }, session });
    return {
      tx,
      transaction,
      session,
      prisma: { $transaction: transaction } as unknown as PrismaService,
    };
  };
  const run = <T>(work: () => T, observedAt = Date.now()) =>
    securityRequestContext.run(
      {
        operation: operation(),
        request: createSecurityLease(),
        riskObservation: Object.freeze({
          actorId: 'admin',
          sessionId: 'session',
          authVersion: 2,
          observedAt,
        }),
      },
      work,
    );

  it('requires current role, capability and strong verification without consuming a critical proof', async () => {
    const { prisma, tx, transaction } = setup();
    await expect(
      run(() =>
        withSecurityWrite(prisma, async (client) => {
          expect(client).toBe(tx);
          return 'committed';
        }),
      ),
    ).resolves.toBe('committed');
    expect(lockCurrentSecurityActor).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 'admin' }),
    );
    expect(tx.adminPermissionGrant.findMany).toHaveBeenCalled();
    expect(tx.securityStepUpChallenge.updateMany).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'challenged', 'grant-revoked'] as const)(
    'prevents writes when %s before execution',
    async (state) => {
      const { prisma, tx, session } = setup();
      const work = jest.fn();
      if (state === 'expired')
        session.strongAuthenticatedAt = new Date(Date.now() - 301000);
      if (state === 'challenged') session.riskState = 'CHALLENGE';
      if (state === 'grant-revoked')
        tx.adminPermissionGrant.findMany.mockResolvedValue([]);
      await expect(
        run(() => withSecurityTransaction(prisma, work)),
      ).rejects.toMatchObject({
        status: state === 'grant-revoked' ? 403 : 409,
      });
      expect(work).not.toHaveBeenCalled();
    },
  );

  it('rolls back instead of committing when the request ends during the command', async () => {
    const { prisma } = setup();
    const request = createSecurityLease();
    await expect(
      securityRequestContext.run(
        {
          operation: operation(),
          request,
          riskObservation: {
            actorId: 'admin',
            sessionId: 'session',
            authVersion: 2,
            observedAt: Date.now(),
          },
        },
        () =>
          withSecurityTransaction(prisma, async () => {
            request.close();
            return 'must not commit';
          }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each(['verification-window', 'risk-observation'] as const)(
    'does not commit when %s expires during awaited work',
    async (reason) => {
      const { prisma, session } = setup();
      let time = Date.now();
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => time);
      if (reason === 'verification-window')
        session.strongAuthenticatedAt = new Date(time - 299000);
      const work = jest.fn(async () => {
        time += reason === 'verification-window' ? 2000 : 121000;
        return 'uncommitted';
      });
      try {
        await expect(
          run(() => withSecurityTransaction(prisma, work)),
        ).rejects.toMatchObject({
          status: 409,
          response: expect.objectContaining({
            code: 'SECURITY_VERIFICATION_RESTART_REQUIRED',
          }),
        });
        expect(work).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('does not fabricate a risk observation for a context that has none', async () => {
    const { prisma } = setup();
    const work = jest.fn();
    await expect(
      securityRequestContext.run(
        { operation: operation(), request: createSecurityLease() },
        () => withSecurityTransaction(prisma, work),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(work).not.toHaveBeenCalled();
  });

  it('keeps nested administrator writes inside the same authorized transaction', async () => {
    const { prisma, tx, transaction } = setup();
    await run(() =>
      withSecurityTransaction(prisma, () =>
        withSecurityWrite(prisma, async (client) => {
          expect(client).toBe(tx);
        }),
      ),
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
