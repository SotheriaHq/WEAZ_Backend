import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService', () => {
  const alertRow = {
    id: 'alert-1',
    category: 'WEBHOOK',
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
    metadata: {
      webhookSignature: 'raw-signature',
      safeCount: 1,
    },
    dedupeKey: 'dedupe-1',
    occurrenceCount: 2,
    firstSeenAt: new Date('2026-05-31T10:00:00.000Z'),
    lastSeenAt: new Date('2026-05-31T10:05:00.000Z'),
    createdAt: new Date('2026-05-31T10:00:00.000Z'),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    ignoredAt: null,
    ignoredBy: null,
    notificationQueuedAt: null,
    emailQueuedAt: null,
  };

  const buildService = () => {
    const prisma = {
      operationalAlert: {
        findMany: jest.fn().mockResolvedValue([alertRow]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue(alertRow),
        update: jest.fn().mockResolvedValue({
          ...alertRow,
          status: 'ACKNOWLEDGED',
          acknowledgedBy: 'admin-1',
        }),
      },
    };
    return {
      prisma,
      service: new AdminAlertsService(prisma as any),
    };
  };

  it('lists filtered alerts and redacts sensitive metadata', async () => {
    const { prisma, service } = buildService();

    const result = await service.list({
      category: 'webhook',
      severity: 'critical',
      status: 'open',
      search: 'mismatch',
      limit: 250,
    });

    expect(prisma.operationalAlert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          category: 'WEBHOOK',
          severity: 'CRITICAL',
          status: 'OPEN',
          OR: expect.any(Array),
        }),
        take: 101,
      }),
    );
    expect(result.items[0].metadata).toEqual({
      webhookSignature: '[REDACTED]',
      safeCount: 1,
    });
  });

  it('acknowledges an alert with actor tracking', async () => {
    const { prisma, service } = buildService();

    const result = await service.acknowledge('alert-1', 'admin-1');

    expect(prisma.operationalAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: expect.objectContaining({
        status: 'ACKNOWLEDGED',
        acknowledgedBy: 'admin-1',
      }),
    });
    expect(result.status).toBe('ACKNOWLEDGED');
  });

  it('rejects unsupported filter values', async () => {
    const { service } = buildService();

    await expect(service.list({ severity: 'severe' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns not found for unknown alert details', async () => {
    const { prisma, service } = buildService();
    prisma.operationalAlert.findUnique.mockResolvedValue(null);

    await expect(service.getById('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
