import { Test, TestingModule } from '@nestjs/testing';
import { EmailOutboxStatus } from '@prisma/client';

import { EmailOutboxDispatcherService } from './email-outbox-dispatcher.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';

describe('EmailOutboxDispatcherService', () => {
  let service: EmailOutboxDispatcherService;

  const mockPrisma = {
    emailOutbox: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    emailDeliveryAttempt: {
      create: jest.fn(),
    },
    emailSuppression: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as unknown as PrismaService;

  const mockEmailService = {
    sendNow: jest.fn(),
    getDeliveryAttemptProvider: jest.fn(),
    getTransportHost: jest.fn(),
  } as unknown as EmailService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
    (mockPrisma.$queryRaw as jest.Mock).mockImplementation(async () => {
      const calls = (mockPrisma.emailOutbox.findMany as jest.Mock).mock.results;
      const rows = await calls[calls.length - 1]?.value;
      return (rows ?? []).slice(0, 1).map((row: { attempts: number }) => ({
        ...row,
        attempts: row.attempts + 1,
        status: EmailOutboxStatus.PROCESSING,
        lockOwner: 'fixture-claim',
      }));
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailOutboxDispatcherService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmailService, useValue: mockEmailService },
      ],
    }).compile();

    service = module.get(EmailOutboxDispatcherService);
  });

  it('bounds a sweep at 150 messages and performs no work for an empty requested batch', async () => {
    (mockPrisma.emailOutbox.findMany as jest.Mock).mockResolvedValue([]);
    await service.dispatchPendingEmails(1000000);
    expect(mockPrisma.emailOutbox.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 150 }));
    (mockPrisma.emailOutbox.findMany as jest.Mock).mockClear();
    await service.dispatchPendingEmails(0);
    expect(mockPrisma.emailOutbox.findMany).not.toHaveBeenCalled();
    expect(mockEmailService.sendNow).not.toHaveBeenCalled();
  });

  it('logs password reset delivery delay when a queued email is eventually sent', async () => {
    const createdAt = new Date(Date.now() - 60_000);

    (mockPrisma.emailOutbox.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'outbox-1',
        status: EmailOutboxStatus.PENDING,
        attempts: 0,
        recipientEmailSnapshot: 'user@example.com',
        subject: 'Reset your password',
        html: '<p>Reset</p>',
        text: 'Reset',
        scenarioKey: 'auth.password_reset',
        createdAt,
        recipientUserId: 'user-1',
      },
    ]);
    (mockPrisma.emailOutbox.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (mockPrisma.emailDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailOutbox.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailSuppression.findFirst as jest.Mock).mockResolvedValue(
      null,
    );
    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (work: any) => typeof work === 'function' ? work(mockPrisma) : Promise.all(work),
    );
    (mockEmailService.sendNow as jest.Mock).mockResolvedValue({
      providerMessageId: 'msg-1',
    });
    (mockEmailService.getDeliveryAttemptProvider as jest.Mock).mockReturnValue(
      'RESEND',
    );
    (mockEmailService.getTransportHost as jest.Mock).mockReturnValue(
      'api.resend.com',
    );

    const logSpy = jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);

    await service.dispatchPendingEmails();

    expect(mockEmailService.sendNow).toHaveBeenCalledWith(
      'user@example.com',
      'Reset your password',
      '<p>Reset</p>',
      'Reset',
      { idempotencyKey: 'outbox:outbox-1' },
    );
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes(
          'Password reset email delivered outboxId=outbox-1',
        ),
      ),
    ).toBe(true);
    expect(mockPrisma.emailOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: {
                in: [EmailOutboxStatus.PENDING, EmailOutboxStatus.FAILED],
              },
            }),
          ]),
        }),
      }),
    );
  });

  it('reclaims expired processing password reset rows for retry', async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000);

    (mockPrisma.emailOutbox.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'outbox-3',
        status: EmailOutboxStatus.PROCESSING,
        attempts: 2,
        recipientEmailSnapshot: 'user@example.com',
        subject: 'Reset your password',
        html: '<p>Reset</p>',
        text: 'Reset',
        scenarioKey: 'auth.password_reset',
        createdAt,
        lockExpiresAt: new Date(Date.now() - 5_000),
        recipientUserId: 'user-3',
      },
    ]);
    (mockPrisma.emailOutbox.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (mockPrisma.emailDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailOutbox.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailSuppression.findFirst as jest.Mock).mockResolvedValue(
      null,
    );
    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (work: any) => typeof work === 'function' ? work(mockPrisma) : Promise.all(work),
    );
    (mockEmailService.sendNow as jest.Mock).mockResolvedValue({
      providerMessageId: 'msg-2',
    });
    (mockEmailService.getDeliveryAttemptProvider as jest.Mock).mockReturnValue(
      'RESEND',
    );
    (mockEmailService.getTransportHost as jest.Mock).mockReturnValue(
      'api.resend.com',
    );

    await service.dispatchPendingEmails();

    expect(mockPrisma.emailOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: EmailOutboxStatus.PROCESSING,
            }),
          ]),
        }),
      }),
    );
    expect(mockPrisma.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-3', status: EmailOutboxStatus.PROCESSING, lockOwner: 'fixture-claim' },
      }),
    );
    expect(mockEmailService.sendNow).toHaveBeenCalledWith(
      'user@example.com',
      'Reset your password',
      '<p>Reset</p>',
      'Reset',
      { idempotencyKey: 'outbox:outbox-3' },
    );
  });

  it('immediately retries password reset rows that previously failed with a timeout', async () => {
    const createdAt = new Date(Date.now() - 60 * 60_000);

    (mockPrisma.emailOutbox.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'outbox-timeout',
        status: EmailOutboxStatus.FAILED,
        attempts: 6,
        recipientEmailSnapshot: 'user@example.com',
        subject: 'Reset your password',
        html: '<p>Reset</p>',
        text: 'Reset',
        scenarioKey: 'auth.password_reset',
        createdAt,
        availableAt: new Date(Date.now() + 30 * 60_000),
        lastError: 'Connection timeout',
        recipientUserId: 'user-timeout',
      },
    ]);
    (mockPrisma.emailOutbox.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (mockPrisma.emailDeliveryAttempt.create as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailOutbox.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.emailSuppression.findFirst as jest.Mock).mockResolvedValue(
      null,
    );
    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (work: any) => typeof work === 'function' ? work(mockPrisma) : Promise.all(work),
    );
    (mockEmailService.sendNow as jest.Mock).mockResolvedValue({
      providerMessageId: 'msg-timeout',
    });
    (mockEmailService.getDeliveryAttemptProvider as jest.Mock).mockReturnValue(
      'RESEND',
    );
    (mockEmailService.getTransportHost as jest.Mock).mockReturnValue(
      'api.resend.com',
    );

    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await service.dispatchPendingEmails();

    expect(mockPrisma.emailOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: EmailOutboxStatus.FAILED,
              scenarioKey: {
                in: ['auth.password_reset', 'auth.admin_password_reset'],
              },
              lastError: {
                contains: 'timeout',
                mode: 'insensitive',
              },
            }),
          ]),
        }),
      }),
    );
    expect(mockEmailService.sendNow).toHaveBeenCalledWith(
      'user@example.com',
      'Reset your password',
      '<p>Reset</p>',
      'Reset',
      { idempotencyKey: 'outbox:outbox-timeout' },
    );
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes(
          'Password reset email delivered outboxId=outbox-timeout',
        ),
      ),
    ).toBe(true);
  });

  it('bounds a stalled provider attempt and releases its deadline timer', async () => {
    jest.useFakeTimers();
    try {
      const pending = (service as any).withDeliveryTimeout(new Promise(() => {}));
      const result = expect(pending).rejects.toThrow('Email provider timeout');
      await jest.advanceTimersByTimeAsync(30_000);
      await result;
      expect(jest.getTimerCount()).toBe(0);
      await expect((service as any).withDeliveryTimeout(Promise.resolve('sent'))).resolves.toBe('sent');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not write a delivery log when another worker owns the claim', async () => {
    (mockPrisma.emailOutbox.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async work => work(mockPrisma));
    const owned = await (service as any).finishClaim({ id: 'outbox-stale', lockOwner: 'old-owner' }, { status: 'COMPLETED' }, { result: 'SENT' });
    expect(owned).toBe(false);
    expect(mockPrisma.emailDeliveryAttempt.create).not.toHaveBeenCalled();
  });

  it('escalates stale password reset outbox rows', async () => {
    const staleCreatedAt = new Date(Date.now() - 20 * 60_000);

    (mockPrisma.emailOutbox.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'outbox-2',
        recipientUserId: 'user-2',
        scenarioKey: 'auth.admin_password_reset',
        status: EmailOutboxStatus.FAILED,
        attempts: 3,
        availableAt: new Date(Date.now() + 60_000),
        lastError: 'Resend timeout while sending password reset email',
        createdAt: staleCreatedAt,
        updatedAt: staleCreatedAt,
        lockOwner: 'api-123',
        lockExpiresAt: new Date(Date.now() + 30_000),
      },
    ]);

    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await service.reportPasswordResetEmailDelays();

    expect(mockPrisma.emailOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scenarioKey: {
            in: ['auth.password_reset', 'auth.admin_password_reset'],
          },
          status: {
            in: [
              EmailOutboxStatus.PENDING,
              EmailOutboxStatus.PROCESSING,
              EmailOutboxStatus.FAILED,
            ],
          },
          sentAt: null,
        }),
      }),
    );
    expect(
      errorSpy.mock.calls.some(([message]) =>
        String(message).includes('Password reset email delay detected'),
      ),
    ).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
