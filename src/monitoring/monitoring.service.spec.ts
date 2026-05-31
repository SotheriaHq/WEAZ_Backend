import { MonitoringService } from './monitoring.service';

describe('MonitoringService', () => {
  const buildPersistingService = (overrides?: {
    upsertResult?: Record<string, unknown>;
  }) => {
    const alertRow = {
      id: 'alert-1',
      category: 'PAYMENT',
      severity: 'CRITICAL',
      event: 'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
      title: 'Payment mismatch',
      message: 'Payment mismatch detected',
      status: 'OPEN',
      actorId: null,
      userId: null,
      entityType: 'PaymentAttempt',
      entityId: 'attempt-1',
      correlationId: 'corr-1',
      metadata: { webhookSignature: '[REDACTED]' },
      dedupeKey: 'dedupe-1',
      occurrenceCount: 1,
      firstSeenAt: new Date('2026-05-31T10:00:00.000Z'),
      lastSeenAt: new Date('2026-05-31T10:00:00.000Z'),
      createdAt: new Date('2026-05-31T10:00:00.000Z'),
      ...overrides?.upsertResult,
    };
    const prisma = {
      operationalAlert: {
        upsert: jest.fn().mockResolvedValue(alertRow),
        create: jest.fn().mockResolvedValue(alertRow),
        update: jest.fn().mockResolvedValue(alertRow),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'admin-1',
            email: 'admin@example.test',
          },
        ]),
      },
    };
    const emailService = {
      send: jest.fn().mockResolvedValue({ outboxId: 'outbox-1' }),
    };
    const notificationsService = {
      create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
    };
    const service = new MonitoringService(
      prisma as any,
      undefined,
      emailService as any,
      notificationsService as any,
    );
    return { service, prisma, emailService, notificationsService };
  };

  it('redacts secrets and private payload fields before buffering alerts', () => {
    const service = new MonitoringService();

    const alert = service.emitAlert({
      category: 'PAYMENT',
      severity: 'critical',
      event: 'payment_mismatch',
      message: 'Payment mismatch detected',
      metadata: {
        token: 'jwt-token',
        cookie: 'session=raw',
        password: 'RawPassword123',
        webhookSignature: 'paystack-signature',
        paystackSecret: 'sk_live_sensitive',
        s3Key: 'PRIVATE/user_1/file.png',
        signedUrl:
          'https://bucket.s3.eu-north-1.amazonaws.com/key?X-Amz-Signature=raw',
        payment: {
          cardNumber: '4084084084084081',
          cvv: '123',
          paymentMetadata: { email: 'buyer@example.com' },
        },
      },
    });

    expect(alert.metadata).toEqual({
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      password: '[REDACTED]',
      webhookSignature: '[REDACTED]',
      paystackSecret: '[REDACTED]',
      s3Key: '[REDACTED]',
      signedUrl: '[REDACTED]',
      payment: {
        cardNumber: '[REDACTED]',
        cvv: '[REDACTED]',
        paymentMetadata: { email: '[REDACTED]' },
      },
    });
    expect(JSON.stringify(alert)).not.toContain('sk_live_sensitive');
    expect(JSON.stringify(alert)).not.toContain('X-Amz-Signature');
  });

  it('buffers metric-like events for local tests without external delivery', () => {
    const service = new MonitoringService();

    service.emitMetric('market_signal_duplicate_replay', { count: 2 }, 'RANKING');

    expect(service.getBufferedAlerts()).toEqual([
      expect.objectContaining({
        category: 'RANKING',
        severity: 'info',
        event: 'market_signal_duplicate_replay',
        metadata: { count: 2 },
      }),
    ]);
  });

  it('persists critical alerts and routes redacted admin notification plus email outbox', async () => {
    const { service, prisma, emailService, notificationsService } =
      buildPersistingService();

    const alert = service.emitAlert({
      category: 'PAYMENT',
      severity: 'critical',
      event: 'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
      message: 'Payment mismatch detected',
      correlationId: 'corr-1',
      entityType: 'PaymentAttempt',
      entityId: 'attempt-1',
      metadata: {
        webhookSignature: 'raw-signature',
        paystackSecret: 'sk_live_sensitive',
      },
    });
    await service.flushPendingPersistenceForTests();

    expect(prisma.operationalAlert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          severity: 'CRITICAL',
          metadata: expect.objectContaining({
            webhookSignature: '[REDACTED]',
            paystackSecret: '[REDACTED]',
          }),
        }),
      }),
    );
    expect(notificationsService.create).toHaveBeenCalledWith(
      'admin-1',
      'ADMIN_ACTION',
      expect.objectContaining({
        payload: expect.objectContaining({
          operationalAlertId: 'alert-1',
          targetUrl: '/admin/monitoring?alertId=alert-1',
        }),
        suppressEmail: true,
        suppressPush: true,
      }),
    );
    expect(emailService.send).toHaveBeenCalledWith(
      'admin@example.test',
      expect.stringContaining('CRITICAL PAYMENT alert'),
      expect.not.stringContaining('sk_live_sensitive'),
      expect.not.stringContaining('raw-signature'),
      expect.objectContaining({
        scenarioKey: 'operational.alert.critical',
      }),
    );
    expect(JSON.stringify(alert)).not.toContain('sk_live_sensitive');
  });

  it('dedupes repeated alert delivery using occurrence count', async () => {
    const { service, emailService, notificationsService } = buildPersistingService({
      upsertResult: { occurrenceCount: 3 },
    });

    service.emitAlert({
      category: 'WEBHOOK',
      severity: 'critical',
      event: 'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
      message: 'Payment mismatch detected',
    });
    await service.flushPendingPersistenceForTests();

    expect(notificationsService.create).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('creates in-app admin notifications for configured warning events without email', async () => {
    const { service, emailService, notificationsService } = buildPersistingService({
      upsertResult: {
        category: 'UPLOAD',
        severity: 'WARNING',
        event: 'upload_finalize_owner_mismatch',
        occurrenceCount: 1,
      },
    });

    service.emitAlert({
      category: 'UPLOAD',
      severity: 'warning',
      event: 'upload_finalize_owner_mismatch',
      message: 'Upload owner mismatch',
    });
    await service.flushPendingPersistenceForTests();

    expect(notificationsService.create).toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });
});
