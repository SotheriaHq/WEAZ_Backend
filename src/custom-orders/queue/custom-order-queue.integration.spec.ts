import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';
import { SettlementSnapshotService } from 'src/finance/settlement-snapshot.service';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';

const databaseUrl = process.env.QUEUE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/** Uses an explicitly named disposable database; never an application datasource. */
integration('paid queue PostgreSQL transaction integration', () => {
  let prisma: PrismaClient;
  let queue: CustomOrderQueueService;
  let finance: CustomOrderFinanceSyncService;
  let refunds: CustomOrderQueueRefundsService;
  const brandId = randomUUID(), ownerId = randomUUID(), buyerId = randomUUID();
  let configurationId: string, configurationVersionId: string;
  const attemptReference = `queue-integration-${randomUUID()}`;
  const originalFetch = global.fetch;
  const originalPaystackKey = process.env.PAYSTACK_SECRET_KEY;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/wiez_queue_validation_')) throw new Error('QUEUE_TEST_DATABASE_URL must identify an isolated local queue validation database');
    prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: databaseUrl, max: 10 })) });
    const ledger = new LedgerService(prisma as any);
    // Fixed fixture pricing isolates queue/ledger transactions from price-rule selection.
    const calculator = { calculate: async (input: any) => ({
      ...input, orderId: null, commissionRuleId: null, commissionScope: null, commissionSource: null,
      commissionRate: 10, commissionAmount: input.grossAmount * .1, brandNetAmount: input.grossAmount * .9,
      settlementPolicyId: null, releaseMode: 'SPLIT_RELEASE', upfrontReleaseEnabled: true, upfrontReleasePercent: 60,
      upfrontReleaseGrossAmount: input.grossAmount * .6, upfrontReleaseCommissionAmount: input.grossAmount * .06, upfrontReleaseNetBrandAmount: input.grossAmount * .54,
      finalReleaseGrossAmount: input.grossAmount * .4, finalReleaseCommissionAmount: input.grossAmount * .04, finalReleaseNetBrandAmount: input.grossAmount * .36,
      settlementDelayHours: 48, autoReleaseDays: 7, finalReleaseTrigger: 'BUYER_CONFIRMATION', calculatedAt: new Date(),
    }) };
    finance = new CustomOrderFinanceSyncService(prisma as any, ledger, calculator as any, new SettlementSnapshotService(prisma as any));
    queue = new CustomOrderQueueService(prisma as any, { assertPermission: async () => undefined } as any, finance, ledger);
    refunds = new CustomOrderQueueRefundsService(prisma as any, ledger);
    await prisma.user.createMany({ data: [
      { id: ownerId, username: `owner-${ownerId}`, email: `${ownerId}@example.invalid`, type: 'BRAND' },
      { id: buyerId, username: `buyer-${buyerId}`, email: `${buyerId}@example.invalid`, type: 'REGULAR' },
    ] });
    await prisma.brand.create({ data: { id: brandId, name: 'Queue integration fixture', ownerId, verificationStatus: 'APPROVED', activeOrderCapOverride: 1, queueJumpEnabled: true } });
    await prisma.brandSubscription.create({ data: { brandId, tierKey: 'ARU', priceSnapshotNgn: 30000, status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000), nextChargeAt: new Date(Date.now() + 86400000) } });
    const basis = await prisma.customFabricRuleBasis.create({ data: { label: 'Queue fixture', brandId } });
    const configuration = await prisma.customOrderConfiguration.create({ data: { brandId, sourceType: 'DESIGN', sourceId: randomUUID(), title: 'Queue fixture', fabricRuleBasisId: basis.id, baseProductionCharge: 1000, fabricCostPerYard: 0, productionLeadDays: 3, deliveryMinDays: 1, deliveryMaxDays: 2, deliveryScope: 'NG', revisionPolicy: 'Fixture', returnPolicy: 'Fixture', defectPolicy: 'Fixture', fabricSourcingMode: 'BRAND_SOURCED' } });
    configurationId = configuration.id;
    const version = await prisma.customOrderConfigurationVersion.create({ data: { configurationId, version: 1, snapshotJson: {}, createdById: ownerId } });
    configurationVersionId = version.id;
    await prisma.paymentAttempt.create({ data: { reference: attemptReference, provider: 'PAYSTACK', providerMode: 'test', status: 'PAID', amount: 10000, currency: 'NGN', buyerId, subjectType: 'UNIFIED_CHECKOUT' } });
  }, 30000);

  afterAll(async () => {
    global.fetch = originalFetch;
    if (originalPaystackKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = originalPaystackKey;
    await prisma?.$disconnect();
  });

  async function paidOrder(jump = 0) {
    return prisma.customOrder.create({ data: {
      brandId, buyerId, configurationId, configurationVersionId, sourceType: 'DESIGN', sourceId: randomUUID(), sourceTitleSnapshot: 'Queue fixture',
      paymentStatus: 'PAID', paymentMethod: 'PAYSTACK', paymentReference: attemptReference, baseProductionChargeSnapshot: 1000,
      fabricCostPerYardSnapshot: 0, computedYards: 0, internalPriceBreakdownJson: {},
      buyerPriceSummaryJson: { outfitTotal: '1000.00', delivery: '50.00', queueJumpFee: jump.toFixed(2), grandTotal: (1050 + jump).toFixed(2) },
      measurementSnapshotJson: {}, measurementConfirmedAt: new Date(), productionLeadDaysSnapshot: 3, deliveryMinDaysSnapshot: 1, deliveryMaxDaysSnapshot: 2,
    } });
  }

  it('serializes admission, preserves Up Next, holds the whole capture, and cancels only one sibling', async () => {
    const first = await paidOrder(), second = await paidOrder(), priority = await paidOrder(200), fourth = await paidOrder();
    await prisma.$transaction(tx => queue.admitPaid(tx, first.id));
    await prisma.$transaction(tx => queue.admitPaid(tx, second.id));
    await Promise.all([priority, fourth].map(order => prisma.$transaction(tx => queue.admitPaid(tx, order.id), { timeout: 15000 })));
    expect(await prisma.customOrder.count({ where: { brandId, lane: 'ACTIVE' } })).toBe(1);
    expect(await prisma.customOrder.count({ where: { brandId, lane: 'UP_NEXT' } })).toBe(1);
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: second.id } })).lane).toBe('UP_NEXT');
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: priority.id } })).lane).toBe('PENDING');
    expect(await prisma.customOrderLedgerAllocation.count({ where: { customOrderId: priority.id, allocationType: { in: ['BRAND_ACCEPTANCE_PORTION', 'FINAL_COMPLETION_PORTION', 'JUMP_FEE'] } } })).toBe(0);
    const capture = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `ledger:custom-order:${priority.id}:payment_received` } });
    expect(Number(capture.totalAmount)).toBe(1250);

    await Promise.all([queue.cancel(buyerId, priority.id, 'Buyer cancellation'), queue.cancel(buyerId, priority.id, 'Buyer cancellation retry')]);
    expect(await prisma.customOrderQueueRefund.count({ where: { customOrderId: priority.id } })).toBe(1);
    const refund = await prisma.customOrderQueueRefund.findUniqueOrThrow({ where: { customOrderId: priority.id } });
    expect(Number(refund.amount)).toBe(1130);
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: attemptReference } })).status).toBe('PAID');
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: first.id } })).paymentStatus).toBe('PAID');

    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: true, data: { id: 987654, transaction_reference: attemptReference, amount: 113000, currency: 'NGN', status: 'processed' } }) })) as any;
    await refunds.processPending();
    const settled = await prisma.customOrderQueueRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(settled.status).toBe('SETTLED');
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: priority.id } })).status).toBe('CLOSED');
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: attemptReference } })).status).toBe('PAID');
    const posts = await prisma.ledgerTransaction.findMany({ where: { referenceId: priority.id }, include: { entries: true } });
    for (const post of posts) {
      const debits = post.entries.filter(entry => entry.direction === 'DEBIT').reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
      const credits = post.entries.filter(entry => entry.direction === 'CREDIT').reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
      expect(debits.equals(credits)).toBe(true);
    }
  }, 30000);
});
