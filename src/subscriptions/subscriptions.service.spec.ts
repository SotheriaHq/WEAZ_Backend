import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

describe('SubscriptionsService boundary and payment invariants', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  let service: SubscriptionsService;
  let prisma: any;
  let access: any;
  let paystack: any;
  const current = () => ({
    id: 'sub-current',
    brandId: 'brand-one',
    tierKey: 'THREAD',
    status: 'ACTIVE',
    priceSnapshotNgn: 10000,
    currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
    billingAnchorDay: 1,
    cancelAtPeriodEnd: false,
    scheduledTierKey: null,
    providerCustomerEmail: 'brand@example.com',
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      $transaction: jest.fn((callback) => callback(prisma)),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      brandSubscription: {
        findFirst: jest.fn().mockResolvedValue(current()),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      subscriptionTier: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ key: 'ARU', monthlyPriceNgn: 30000 }),
      },
      brandSubscriptionInvoice: {
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      brand: {
        update: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      brandSubscriptionPaymentCapture: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'capture-new' }),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
      },
      operationalAlert: { upsert: jest.fn(), updateMany: jest.fn() },
      notification: { upsert: jest.fn() },
      emailOutbox: { upsert: jest.fn() },
    };
    access = {
      assertBrandOwnerAndResolve: jest
        .fn()
        .mockResolvedValue({ brandId: 'brand-one' }),
    };
    paystack = {
      verify: jest.fn(),
      initialize: jest.fn(),
      charge: jest.fn(),
      verifyRefund: jest.fn(),
      refund: jest.fn(),
    };
    service = new SubscriptionsService(
      prisma,
      access,
      { recordAcceptedDocuments: jest.fn() } as any,
      paystack,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('authorizes ownership before exposing any invoice or tier context', async () => {
    access.assertBrandOwnerAndResolve.mockRejectedValue(
      new ForbiddenException(),
    );
    await expect(
      service.getForOwner('outsider', 'brand-one'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.brandSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('previews prorated upgrade without initializing or charging a provider', async () => {
    const preview = await service.previewForOwner('owner', 'brand-one', 'ARU');
    expect(preview.kind).toBe('UPGRADE');
    expect(preview.amountNgn).toBeCloseTo(8709.68, 2);
    expect(preview.periodEnd).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(paystack.initialize).not.toHaveBeenCalled();
    expect(paystack.charge).not.toHaveBeenCalled();
  });

  it('schedules a downgrade at renewal without crediting the paid period', async () => {
    prisma.brandSubscription.findFirst.mockResolvedValue({
      ...current(),
      tierKey: 'IGWE',
      priceSnapshotNgn: 50000,
    });
    prisma.subscriptionTier.findUnique.mockResolvedValue({
      key: 'THREAD',
      monthlyPriceNgn: 10000,
    });
    const preview = await service.previewForOwner(
      'owner',
      'brand-one',
      'THREAD',
    );
    expect(preview.kind).toBe('DOWNGRADE');
    expect(preview.effectiveAt).toEqual(current().currentPeriodEnd);
    expect(preview.amountNgn).toBe(10000);
  });

  it('rejects omitted recurring consent before creating or initializing payment', async () => {
    await expect(
      service.checkout('owner', 'brand-one', {
        tierKey: 'ARU',
        legalVersion: '2026.10.19-v1.4',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(paystack.initialize).not.toHaveBeenCalled();
  });

  it('does not accept a provider success with the wrong invoice amount', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PENDING',
      subscription: current(),
    };
    prisma.brandSubscriptionInvoice.findFirst.mockResolvedValue(invoice);
    paystack.verify.mockResolvedValue({
      reference: invoice.reference,
      status: 'success',
      amount: 1,
      currency: 'NGN',
      customer: { email: 'brand@example.com' },
    });
    await expect(
      service.verifyForOwner('owner', 'brand-one', invoice.reference),
    ).rejects.toThrow('billing review');
    expect(prisma.brandSubscription.update).not.toHaveBeenCalled();
  });

  it('replaying a paid invoice never reactivates or extends its subscription', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PAID',
      subscription: current(),
    };
    prisma.brandSubscriptionInvoice.findUnique.mockResolvedValue(invoice);
    prisma.brandSubscriptionPaymentCapture.findUnique.mockResolvedValue({
      status: 'APPLIED',
    });
    expect(await service.handleProviderCharge(invoice.reference)).toBe(true);
    expect(paystack.verify).not.toHaveBeenCalled();
    expect(prisma.brandSubscription.update).not.toHaveBeenCalled();
  });

  it('routes unrelated payment references back to ordinary checkout', async () => {
    expect(await service.handleProviderCharge('order-payment-one')).toBe(false);
    expect(prisma.brandSubscriptionInvoice.findUnique).not.toHaveBeenCalled();
  });

  it('retains an extra capture as compensation without extending an already paid invoice', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PAID',
      subscription: current(),
      purpose: 'RENEWAL',
      periodStart: now,
      periodEnd: new Date('2026-11-18T12:00:00Z'),
    };
    prisma.brandSubscriptionInvoice.findUnique.mockResolvedValue(invoice);
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    prisma.brandSubscriptionPaymentCapture.findUnique.mockResolvedValue(null);
    paystack.verify.mockResolvedValue({
      reference: 'wzsub-abc-a2',
      status: 'success',
      amount: 1_000_000,
      currency: 'NGN',
      id: 123,
      paid_at: now.toISOString(),
      customer: { email: 'brand@example.com' },
    });
    expect(await service.handleProviderCharge('wzsub-abc-a2')).toBe(true);
    expect(prisma.brandSubscriptionPaymentCapture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reference: 'wzsub-abc-a2',
          amount: 10000,
        }),
      }),
    );
    expect(prisma.brandSubscriptionPaymentCapture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPENSATION_REQUIRED',
          reason: 'DUPLICATE_CAPTURE',
        }),
      }),
    );
    expect(prisma.brandSubscription.update).not.toHaveBeenCalled();
  });

  it('keeps entitlement unchanged for a renewal paid after its strict recovery cutoff', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PENDING',
      subscription: current(),
      purpose: 'RENEWAL',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      periodEnd: new Date('2026-11-01T00:00:00Z'),
    };
    prisma.brandSubscriptionInvoice.findUnique.mockResolvedValue(invoice);
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    paystack.verify.mockResolvedValue({
      reference: invoice.reference,
      status: 'success',
      amount: 1_000_000,
      currency: 'NGN',
      id: 123,
      paid_at: now.toISOString(),
      customer: { email: 'brand@example.com' },
    });
    await service.handleProviderCharge(invoice.reference);
    expect(prisma.brandSubscriptionInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PAID_REVIEW' }),
      }),
    );
    expect(prisma.brandSubscriptionPaymentCapture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPENSATION_REQUIRED',
          reason: 'LATE_CAPTURE',
        }),
      }),
    );
    expect(prisma.brandSubscription.update).not.toHaveBeenCalled();
  });

  it('commits a durable receipt and transactional email with a confirmed entitlement payment', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PENDING',
      subscription: current(),
      purpose: 'RENEWAL',
      periodStart: now,
      periodEnd: new Date('2026-11-18T12:00:00Z'),
    };
    prisma.brand.findUnique.mockResolvedValue({
      ownerId: 'owner',
      owner: { email: 'brand@example.com' },
    });
    prisma.brandSubscriptionInvoice.findUnique.mockResolvedValue(invoice);
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    paystack.verify.mockResolvedValue({
      reference: invoice.reference,
      status: 'success',
      amount: 1_000_000,
      currency: 'NGN',
      id: 123,
      paid_at: now.toISOString(),
      customer: { email: 'brand@example.com' },
    });
    await service.handleProviderCharge(invoice.reference);
    expect(prisma.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          recipientId: 'owner',
          payload: expect.objectContaining({ action: 'SUBSCRIPTION_BILLING' }),
        }),
      }),
    );
    expect(prisma.emailOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          priority: 'P1_TRANSACTIONAL',
          idempotencyKey: 'subscription-paid-invoice-one',
        }),
      }),
    );
  });

  it('never blindly resubmits an interrupted refund without a provider refund ID', async () => {
    const capture = {
      id: 'capture-one',
      reference: 'wzsub-abc-a2',
      amount: 10000,
      status: 'REFUND_SUBMITTING',
      providerRefundId: null,
      invoice: { id: 'invoice-one', subscription: current() },
    };
    prisma.brandSubscriptionPaymentCapture.findMany.mockResolvedValue([
      { id: capture.id },
    ]);
    prisma.brandSubscriptionPaymentCapture.updateMany.mockResolvedValue({
      count: 1,
    });
    prisma.brandSubscriptionPaymentCapture.findUniqueOrThrow.mockResolvedValue(
      capture,
    );
    prisma.brandSubscriptionPaymentCapture.update.mockResolvedValue(capture);
    await (service as any).processCompensations(now);
    expect(paystack.refund).not.toHaveBeenCalled();
    expect(prisma.brandSubscriptionPaymentCapture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'NEEDS_ATTENTION' }),
      }),
    );
  });

  it('enforces finance permissions again inside the compensation service', async () => {
    await expect(
      service.listCompensations({
        id: 'buyer',
        role: 'User' as any,
        permissions: ['payouts.read'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      prisma.brandSubscriptionPaymentCapture.findMany,
    ).not.toHaveBeenCalled();
  });

  it('rejects an admin-supplied refund ID whose verified refund amount belongs to another liability', async () => {
    prisma.brandSubscriptionPaymentCapture.findUnique.mockResolvedValue({
      id: 'capture-one',
      status: 'NEEDS_ATTENTION',
      reference: 'wzsub-abc-a2',
      providerTransactionId: '123',
      amount: 10000,
      currency: 'NGN',
    });
    paystack.verifyRefund.mockResolvedValue({
      id: 77,
      transaction: { id: 123, reference: 'wzsub-abc-a2' },
      amount: 1,
      currency: 'NGN',
      status: 'processed',
    });
    await expect(
      service.reconcileCompensation(
        { id: 'admin', role: 'SuperAdmin' as any },
        'capture-one',
        '77',
      ),
    ).rejects.toThrow('does not match');
    expect(
      prisma.brandSubscriptionPaymentCapture.update,
    ).not.toHaveBeenCalled();
  });

  it('opens manual recovery after a definitive automatic failure and keeps the processor email snapshot', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'FAILED',
      subscription: current(),
      purpose: 'RENEWAL',
      attemptCount: 1,
      hostedReference: null,
      hostedAttemptReferences: [],
      lockedAt: null,
    };
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    paystack.verify.mockImplementation(async (reference) =>
      reference.endsWith('-a1')
        ? {
            reference,
            status: 'failed',
            amount: 1_000_000,
            currency: 'NGN',
            customer: { email: 'brand@example.com' },
          }
        : null,
    );
    const hosted = await (service as any).prepareHostedPayment(
      invoice.id,
      'changed-owner@example.com',
    );
    expect(hosted.reference).toBe(invoice.reference);
    expect(hosted.email).toBe('brand@example.com');
    expect(prisma.brandSubscriptionInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'HOSTED_INITIALIZING',
          hostedReference: invoice.reference,
          hostedAttemptReferences: [invoice.reference],
        }),
      }),
    );
    expect(paystack.charge).not.toHaveBeenCalled();
  });

  it('blocks a new debit while an older automatic attempt is uncertain', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'FAILED',
      subscription: current(),
      purpose: 'RENEWAL',
      attemptCount: 1,
      hostedReference: null,
      hostedAttemptReferences: [],
      lockedAt: null,
    };
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    paystack.verify.mockResolvedValue(null);
    await expect(
      (service as any).prepareHostedPayment(invoice.id, 'brand@example.com'),
    ).rejects.toThrow('uncertain');
    expect(prisma.brandSubscriptionInvoice.update).not.toHaveBeenCalled();
    expect(paystack.initialize).not.toHaveBeenCalled();
  });

  it('applies concurrent callback results once under the transaction-lock contract', async () => {
    const invoice = {
      id: 'invoice-one',
      subscriptionId: 'sub-current',
      reference: 'wzsub-abc',
      amount: 10000,
      currency: 'NGN',
      status: 'PENDING',
      subscription: current(),
      purpose: 'RENEWAL',
      periodStart: now,
      periodEnd: new Date('2026-11-18T12:00:00Z'),
    };
    let captured: any = null;
    let pending = Promise.resolve();
    prisma.$transaction.mockImplementation((callback) => {
      const result = pending.then(() => callback(prisma));
      pending = result.catch(() => undefined);
      return result;
    });
    prisma.brandSubscriptionInvoice.findUnique.mockImplementation(async () => ({
      ...invoice,
    }));
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockImplementation(
      async () => ({ ...invoice }),
    );
    prisma.brandSubscriptionPaymentCapture.findUnique.mockImplementation(
      async () => captured,
    );
    prisma.brandSubscriptionPaymentCapture.create.mockImplementation(
      async ({ data }) => {
        captured = { ...data, id: 'capture-new', status: 'APPLIED' };
        return captured;
      },
    );
    prisma.brandSubscriptionInvoice.update.mockImplementation(
      async ({ data }) => Object.assign(invoice, data),
    );
    paystack.verify.mockResolvedValue({
      reference: invoice.reference,
      status: 'success',
      amount: 1_000_000,
      currency: 'NGN',
      id: 123,
      paid_at: now.toISOString(),
      customer: { email: 'brand@example.com' },
    });
    await Promise.all([
      service.handleProviderCharge(invoice.reference),
      service.handleProviderCharge(invoice.reference),
    ]);
    expect(prisma.brandSubscriptionPaymentCapture.create).toHaveBeenCalledTimes(
      1,
    );
    expect(prisma.brandSubscription.update).toHaveBeenCalledTimes(1);
  });
});
