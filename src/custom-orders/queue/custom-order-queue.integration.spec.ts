import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';
import { SettlementSnapshotService } from 'src/finance/settlement-snapshot.service';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { BrandBalanceService } from 'src/finance/brand-balance.service';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';
import { CustomOrderDisputeService } from '../custom-order-dispute.service';
import { CustomOrderRefundService } from '../custom-order-refund.service';

const databaseUrl = process.env.QUEUE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/** Uses an explicitly named disposable database; never an application datasource. */
integration('paid queue PostgreSQL transaction integration', () => {
  let prisma: PrismaClient;
  let pool: Pool;
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
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
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
    queue = new CustomOrderQueueService(prisma as any, { assertPermission: async () => undefined } as any, finance, ledger, new BrandBalanceService(prisma as any));
    refunds = new CustomOrderQueueRefundsService(prisma as any, ledger);
    await prisma.user.createMany({ data: [
      { id: ownerId, username: `owner-${ownerId}`, email: `${ownerId}@example.invalid`, type: 'BRAND' },
      { id: buyerId, username: `buyer-${buyerId}`, email: `${buyerId}@example.invalid`, type: 'REGULAR' },
    ] });
    await prisma.brand.create({ data: { id: brandId, name: 'Queue integration fixture', ownerId, verificationStatus: 'APPROVED', activeOrderCapOverride: 1, queueJumpEnabled: true } });
    await prisma.brandSubscription.create({ data: { brandId, tierKey: 'ARU', priceSnapshotNgn: 30000, status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000) } });
    const basis = await prisma.customFabricRuleBasis.create({ data: { label: 'Queue fixture', brandId } });
    const configuration = await prisma.customOrderConfiguration.create({ data: { brandId, sourceType: 'DESIGN', sourceId: randomUUID(), title: 'Queue fixture', fabricRuleBasisId: basis.id, baseProductionCharge: 1000, fabricCostPerYard: 0, productionLeadDays: 3, deliveryMinDays: 1, deliveryMaxDays: 2, deliveryScope: 'NG', revisionPolicy: 'Fixture', returnPolicy: 'Fixture', defectPolicy: 'Fixture', fabricSourcingMode: 'BRAND_SOURCED' } });
    configurationId = configuration.id;
    const version = await prisma.customOrderConfigurationVersion.create({ data: { configurationId, version: 1, snapshotJson: {}, createdById: ownerId } });
    configurationVersionId = version.id;
    await prisma.paymentAttempt.create({ data: { reference: attemptReference, provider: 'PAYSTACK', providerMode: 'test', paymentMethod: 'PAYSTACK', status: 'PAID', amount: 10000, currency: 'NGN', buyerId, subjectType: 'UNIFIED_CHECKOUT' } });
  }, 30000);

  afterAll(async () => {
    global.fetch = originalFetch;
    if (originalPaystackKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = originalPaystackKey;
    await prisma?.$disconnect();
    await pool?.end();
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
    const refund = await prisma.customOrderQueueRefund.findFirstOrThrow({ where: { customOrderId: priority.id } });
    expect(Number(refund.amount)).toBe(1130);
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: attemptReference } })).status).toBe('PAID');
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: first.id } })).paymentStatus).toBe('PAID');

    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
    global.fetch = jest.fn(async (url) => ({ ok: true, json: async () => ({ status: true, data: String(url).includes('/transaction/verify/') ? { id: 456, reference: attemptReference, amount: 1000000, currency: 'NGN', status: 'success' } : { id: 987654, transaction_reference: attemptReference, amount: 113000, currency: 'NGN', status: 'processed' } }) })) as any;
    await (refunds as any).processOne(refund.id);
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

    // The same shared capture remains order-scoped after work has become Active.
    await prisma.$transaction(tx => queue.requestFullRefundInTransaction(tx, first.id, 'Admin full refund', 'ADMIN', ownerId));
    const activeRefund = await prisma.customOrderQueueRefund.findFirstOrThrow({ where: { customOrderId: first.id } });
    expect(Number(activeRefund.amount)).toBe(1050);
    expect(await prisma.brandBalanceAdjustment.count({ where: { customOrderId: first.id, type: 'REFUND_CLAWBACK' } })).toBe(1);
    const activeReservation = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `ledger:custom-order:${first.id}:queue_refund_reserved` }, include: { entries: { include: { account: true } } } });
    expect(activeReservation.entries.find(entry => entry.account.code === `BRAND_WALLET:${brandId}`)?.amount.equals(567)).toBe(true);
    global.fetch = jest.fn(async (url) => ({ ok: true, json: async () => ({ status: true, data: String(url).includes('/transaction/verify/') ? { id: 456, reference: attemptReference, amount: 1000000, currency: 'NGN', status: 'success' } : { id: 987655, transaction_reference: attemptReference, amount: 105000, currency: 'NGN', status: 'processed' } }) })) as any;
    await (refunds as any).processOne(activeRefund.id);
    expect((await prisma.customOrderQueueRefund.findUniqueOrThrow({ where: { id: activeRefund.id } })).status).toBe('SETTLED');
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: second.id } })).paymentStatus).toBe('PAID');
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: attemptReference } })).status).toBe('PAID');

    const waiting = await paidOrder();
    await prisma.$transaction(tx => queue.admitPaid(tx, waiting.id));
    const expiry = new Date(Date.now() + 36 * 3600000);
    const retainable = await prisma.customOrder.update({ where: { id: waiting.id }, data: { queueExpiresAt: expiry } });
    const outcomes = await Promise.allSettled([queue.retain(buyerId, waiting.id, retainable.orderRevision), queue.retain(buyerId, waiting.id, retainable.orderRevision)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const retained = await prisma.customOrder.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(retained.retainCount).toBe(1);
    expect(retained.queueExpiresAt?.getTime()).toBe(expiry.getTime() + 42 * 86400000);
  }, 30000);

  it('reserves only the agreed partial amount, preserves the lane, and later refunds only the remainder', async () => {
    const order = await paidOrder();
    await prisma.brand.update({ where: { id: brandId }, data: { activeOrderCapOverride: 100 } });
    await prisma.$transaction(tx => queue.admitPaid(tx, order.id));
    const before = await prisma.customOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(before.lane).toBe('ACTIVE');
    const disputeId = randomUUID();
    const [partial, replay] = await Promise.all([1, 2].map(() => prisma.$transaction(tx => queue.requestPartialRefundInTransaction(tx, order.id, 100, disputeId, 'Agreed compensation', ownerId), { timeout: 15000 })));
    expect(replay.id).toBe(partial.id);
    expect(Number(partial.amount)).toBe(100);
    expect(await prisma.customOrderQueueRefund.count({ where: { customOrderId: order.id } })).toBe(1);
    const continuing = await prisma.customOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(continuing.lane).toBe(before.lane);
    expect(continuing.status).toBe(before.status);
    expect(continuing.cancelledAt).toBeNull();
    const final = await prisma.customOrderLedgerAllocation.findFirstOrThrow({ where: { customOrderId: order.id, allocationType: 'FINAL_COMPLETION_PORTION' } });
    expect(final.status).toBe('HELD');
    expect(Number(final.amount)).toBe(380);
    global.fetch = jest.fn(async url => ({ ok: true, json: async () => ({ status: true, data: String(url).includes('/transaction/verify/') ? { id: 456, reference: attemptReference, amount: 1000000, currency: 'NGN', status: 'success' } : { id: 987656, transaction_reference: attemptReference, amount: 10000, currency: 'NGN', status: 'processed' } }) })) as any;
    await (refunds as any).processOne(partial.id);
    const processed = await prisma.customOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(processed.lane).toBe('ACTIVE');
    expect(processed.paymentStatus).toBe('PAID');
    await prisma.$transaction(tx => queue.requestFullRefundInTransaction(tx, order.id, 'Subsequent full remedy', 'ADMIN', ownerId));
    const records = await prisma.customOrderQueueRefund.findMany({ where: { customOrderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(records.map(refund => Number(refund.amount))).toEqual([100, 950]);
    expect(records.map(refund => refund.kind)).toEqual(['PARTIAL', 'CANCELLATION']);
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: attemptReference } })).status).toBe('PAID');
    const debt = await prisma.brandBalanceAdjustment.findFirstOrThrow({ where: { customOrderId: order.id, type: 'REFUND_CLAWBACK' } });
    expect(Number(debt.amount)).toBe(567);
    global.fetch = jest.fn(async url => ({ ok: true, json: async () => ({ status: true, data: String(url).includes('/transaction/verify/') ? { id: 456, reference: attemptReference, amount: 1000000, currency: 'NGN', status: 'success' } : { id: 987657, transaction_reference: attemptReference, amount: 95000, currency: 'NGN', status: 'processed' } }) })) as any;
    await (refunds as any).processOne(records[1].id);
    expect((await prisma.customOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CLOSED');
    expect(await prisma.customOrderQueueRefund.count({ where: { customOrderId: order.id, status: 'SETTLED' } })).toBe(2);
  }, 30000);

  it('resolves a real production dispute into partial compensation and usable production status', async () => {
    const order = await paidOrder();
    await prisma.$transaction(tx => queue.admitPaid(tx, order.id));
    await prisma.customOrder.update({ where: { id: order.id }, data: { status: 'DISPUTED', currentProgressStage: 'DESIGN_MODE', adminInterventionAt: new Date() } });
    const dispute = await prisma.customOrderDispute.create({ data: { customOrderId: order.id, openedById: buyerId, reasonType: 'OTHER', buyerStatement: 'Agreed partial compensation' } });
    const ledger = new LedgerService(prisma as any);
    const refundService = new CustomOrderRefundService(prisma as any, ledger, new BrandBalanceService(prisma as any), queue);
    const disputes = new CustomOrderDisputeService(prisma as any, refundService, { enqueueNotification: async () => undefined } as any);
    await (disputes as any).applyResolution(dispute.id, ownerId, { resolution: 'PARTIAL_REFUND', refundAmount: 10, note: 'Agreed compensation; production continues' }, new Date());
    const continuing = await prisma.customOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(continuing.status).toBe('IN_PRODUCTION');
    expect(continuing.lane).toBe('ACTIVE');
    expect(continuing.cancelledAt).toBeNull();
    expect(Number((await prisma.customOrderQueueRefund.findFirstOrThrow({ where: { customOrderId: order.id } })).amount)).toBe(10);
  }, 30000);
});
