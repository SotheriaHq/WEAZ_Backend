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

  const invoiceRows = async (query: any) => {
    const invoice = query.sql.includes('i.id =')
      ? await prisma.brandSubscriptionInvoice.findUniqueOrThrow({
          where: { id: query.values[0] },
        })
      : query.sql.includes('AND s."brandId"')
        ? await prisma.brandSubscriptionInvoice.findFirst()
        : await prisma.brandSubscriptionInvoice.findUnique();
    if (!invoice) return [];
    const { subscription, ...row } = invoice;
    return [
      {
        ...row,
        agreementBrandId: subscription.brandId,
        agreementCustomerEmail: subscription.providerCustomerEmail,
      },
    ];
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      $transaction: jest.fn((callback) => callback(prisma)),
      $queryRaw: jest
        .fn()
        .mockImplementation(async (query: any) =>
          query.sql?.includes('FROM "BrandSubscriptionInvoice" i')
            ? invoiceRows(query)
            : [],
        ),
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
      notification: { createMany: jest.fn() },
      emailOutbox: { createMany: jest.fn() },
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

  it('rejects subscription tier upgrade when brand is not verified', async () => {
    prisma.brand.findUnique.mockResolvedValue({
      verificationStatus: 'PENDING',
    });
    await expect(
      service.checkout('owner', 'brand-one', {
        tierKey: 'ARU',
        legalVersion: '2026.10.19-v1.4',
        recurringConsent: true,
      } as any),
    ).rejects.toThrow('Only verified brands are eligible for subscription tier upgrades.');
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

  it('reads all paid-invoice capture receipts once without per-reference queries or provider calls', async () => {
    const invoice = {
      id: 'paid-invoice',
      reference: 'wzsub-paid',
      status: 'PAID',
      subscription: current(),
      attemptCount: 4,
      hostedAttemptReferences: Array.from(
        { length: 20 },
        (_, index) => `wzsub-paid-h${index}`,
      ),
    };
    const references = (service as any).paymentReferences(invoice);
    prisma.brandSubscriptionInvoice.findFirst.mockResolvedValue(invoice);
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    prisma.brandSubscriptionPaymentCapture.findMany.mockResolvedValue(
      references.map((reference) => ({ reference, status: 'APPLIED' })),
    );
    jest
      .spyOn(service, 'getForOwner')
      .mockResolvedValue({ subscription: current() } as any);
    expect(
      await service.verifyForOwner('owner', 'brand-one', invoice.reference),
    ).toMatchObject({ paid: true, status: 'PAID' });
    expect(
      prisma.brandSubscriptionPaymentCapture.findMany,
    ).toHaveBeenCalledTimes(1);
    expect(
      prisma.brandSubscriptionPaymentCapture.findMany,
    ).toHaveBeenCalledWith({
      where: { invoiceId: invoice.id, reference: { in: references } },
      select: { reference: true, status: true },
    });
    expect(
      prisma.brandSubscriptionPaymentCapture.findUnique,
    ).not.toHaveBeenCalled();
    expect(paystack.verify).not.toHaveBeenCalled();
  });

  it('refuses another hosted payment from a paid receipt batch', async () => {
    const invoice = {
      id: 'paid-invoice',
      reference: 'wzsub-paid',
      status: 'PAID',
      subscription: current(),
      attemptCount: 0,
    };
    prisma.brandSubscriptionInvoice.findUniqueOrThrow.mockResolvedValue(
      invoice,
    );
    prisma.brandSubscriptionPaymentCapture.findMany.mockResolvedValue([
      { reference: invoice.reference, status: 'APPLIED' },
    ]);
    await expect(
      (service as any).prepareHostedPayment(invoice.id, 'brand@example.com'),
    ).rejects.toThrow('already been received');
    expect(paystack.verify).not.toHaveBeenCalled();
    expect(prisma.brandSubscriptionInvoice.update).not.toHaveBeenCalled();
  });

  it('skips a renewal whose paid period has not yet ended after the current joined guard', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { ...current(), scheduledTierFound: null, scheduledTierPrice: null },
    ]);
    await (service as any).prepareRenewal('sub-current', 'brand-one', now);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.brandSubscription.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(prisma.subscriptionTier.findUnique).not.toHaveBeenCalled();
    expect(prisma.brandSubscription.update).not.toHaveBeenCalled();
    expect(paystack.charge).not.toHaveBeenCalled();
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
    prisma.$queryRaw.mockImplementation(async (query: any) =>
      query.sql?.includes('FROM "BrandSubscriptionInvoice" i')
        ? invoiceRows(query)
        : [{ ownerId: 'owner', email: 'brand@example.com' }],
    );
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
    expect(prisma.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            recipientId: 'owner',
            payload: expect.objectContaining({
              action: 'SUBSCRIPTION_BILLING',
            }),
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(prisma.emailOutbox.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            priority: 'P1_TRANSACTIONAL',
            idempotencyKey: 'subscription-paid-invoice-one',
          }),
        ],
        skipDuplicates: true,
      }),
    );
  });

  it('retains an inbox receipt without an email and skips a missing billing recipient', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ ownerId: 'owner', email: null }])
      .mockResolvedValueOnce([]);
    await (service as any).notifyBilling(
      prisma,
      'brand-one',
      'event',
      'Heading',
      'Message',
    );
    await (service as any).notifyBilling(
      prisma,
      'missing',
      'event',
      'Heading',
      'Message',
    );
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailOutbox.createMany).not.toHaveBeenCalled();
  });

  it('propagates a failed receipt write to its financial transaction instead of swallowing it', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { ownerId: 'owner', email: 'brand@example.com' },
    ]);
    prisma.emailOutbox.createMany.mockRejectedValueOnce(
      new Error('outbox unavailable'),
    );
    await expect(
      (service as any).notifyBilling(
        prisma,
        'brand-one',
        'event',
        'Heading',
        'Message',
      ),
    ).rejects.toThrow('outbox unavailable');
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
    prisma.$queryRaw.mockImplementation(async (query: any) =>
      query.sql?.includes('FROM "BrandSubscriptionPaymentCapture"')
        ? [
            {
              ...capture,
              currency: 'NGN',
              invoiceId: capture.invoice.id,
              invoiceAmount: 10000,
              invoiceCurrency: 'NGN',
              brandId: current().brandId,
            },
          ]
        : [],
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
