// Actual service locks/guards and generated Prisma in a disposable PostgreSQL DB.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const {
  CustomOrdersService,
} = require('../src/custom-orders/custom-orders.service');
const {
  CustomOrderOpsCronService,
} = require('../src/custom-order-ops/custom-order-ops.cron.service');
const {
  CustomOrderQueueRefundsService,
} = require('../src/custom-orders/queue/custom-order-queue-refunds.service');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const {
  CustomOrderQueueService,
} = require('../src/custom-orders/queue/custom-order-queue.service');
const {
  CustomOrderFinanceSyncService,
} = require('../src/finance/custom-order-finance-sync.service');
const { LedgerService } = require('../src/finance/ledger.service');
const {
  SettlementSnapshotService,
} = require('../src/finance/settlement-snapshot.service');
const {
  SettlementCalculatorService,
} = require('../src/finance/settlement-calculator.service');
const {
  SettlementPolicyService,
} = require('../src/finance/settlement-policy.service');
const { CommissionService } = require('../src/finance/commission.service');
const { BrandPermissionService } = require('../src/brands/permissions/brand-permission.service');
const { BrandBalanceService } = require('../src/finance/brand-balance.service');
const { CustomOrderAdminService } = require('../src/custom-order-admin/custom-order-admin.service');
const { loadQueueRefundContexts } = require('../src/custom-orders/queue/queue-refund-query');
const { loadBrandPosition } = require('../src/finance/brand-position-query');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback database required',
  );
  const database = `wiez_issue_race_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false,
    prisma;
  const evidence = {
    checkedAt: new Date().toISOString(),
    passed: false,
    cleanupPassed: false,
    cases: [],
  };
  const waitForBlocked = async () => {
    for (let i = 0; i < 300; i++) {
      const result = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`,
        [database],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error('Expected competing transaction to wait on the order lock');
  };
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        {
          cwd: path.resolve(__dirname, '..'),
          env: {
            ...process.env,
            DATABASE_URL: testUrl.toString(),
            THREADLY_PRISMA_SKIP_SEED: 'true',
          },
          windowsHide: true,
          stdio: 'ignore',
        },
      );
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, 'Disposable migrations must succeed');
    // The adapter owns this pool and closes it on $disconnect. Passing an
    // external pg.Pool relies on instanceof across dependency copies in CI.
    const queries = [];
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (event) => queries.push(event.query));
    const buyer = await prisma.user.create({
      data: {
        id: randomUUID(),
        username: 'race-buyer',
        email: 'race-buyer@example.invalid',
      },
    });
    const owner = await prisma.user.create({
      data: {
        id: randomUUID(),
        username: 'race-maker',
        email: 'race-maker@example.invalid',
        type: 'BRAND',
      },
    });
    const brand = await prisma.brand.create({
      data: { id: randomUUID(), name: 'Race fixture', ownerId: owner.id },
    });
    const basis = await prisma.customFabricRuleBasis.create({
      data: { label: 'Race fixture', brandId: brand.id },
    });
    const configuration = await prisma.customOrderConfiguration.create({
      data: {
        brandId: brand.id,
        sourceType: 'DESIGN',
        sourceId: randomUUID(),
        title: 'Race fixture',
        fabricRuleBasisId: basis.id,
        baseProductionCharge: 100,
        fabricCostPerYard: 0,
        productionLeadDays: 1,
        deliveryMinDays: 1,
        deliveryMaxDays: 2,
        deliveryScope: 'LOCAL',
        revisionPolicy: 'Fixture',
        returnPolicy: 'Fixture',
        defectPolicy: 'Fixture',
        fabricSourcingMode: 'BRAND_SOURCED',
      },
    });
    const version = await prisma.customOrderConfigurationVersion.create({
      data: {
        configurationId: configuration.id,
        version: 1,
        snapshotJson: {},
        createdById: owner.id,
      },
    });
    const createOrder = (recipientId = buyer.id) =>
      prisma.customOrder.create({
        data: {
          brandId: brand.id,
          buyerId: recipientId,
          sourceType: 'DESIGN',
          sourceId: configuration.sourceId,
          sourceTitleSnapshot: 'Race fixture',
          configurationId: configuration.id,
          configurationVersionId: version.id,
          status: 'DELIVERED_PENDING_BUYER_CONFIRMATION',
          paymentStatus: 'PAID',
          baseProductionChargeSnapshot: 100,
          fabricCostPerYardSnapshot: 0,
          computedYards: 0,
          internalPriceBreakdownJson: {},
          buyerPriceSummaryJson: { grandTotal: 100 },
          measurementSnapshotJson: {},
          measurementConfirmedAt: new Date(),
          productionLeadDaysSnapshot: 1,
          deliveryMinDaysSnapshot: 1,
          deliveryMaxDaysSnapshot: 2,
          buyerAcceptanceWindowEndsAt: new Date(Date.now() - 3600000),
        },
      });
    const service = Object.assign(
      Object.create(CustomOrdersService.prototype),
      { prisma },
    );
    const first = await createOrder();
    const held = deferred(),
      release = deferred();
    const complaint = prisma.$transaction(
      async (tx) => {
        await service.lockBuyerOrderForIssue(tx, buyer.id, first.id);
        held.resolve();
        await release.promise;
        await tx.customOrderIssue.create({
          data: {
            customOrderId: first.id,
            issueType: 'UNREASONABLE_DELAY',
            description: 'Fixture',
            openedById: buyer.id,
          },
        });
      },
      { timeout: 15000 },
    );
    await held.promise;
    const notices = [],
      warnings = [],
      financial = [];
    const cron = Object.assign(
      Object.create(CustomOrderOpsCronService.prototype),
      {
        prisma,
        sideEffects: {
          enqueueNotification: async (payload) => notices.push(payload),
        },
        ledgerService: {
          postCustomOrderFinalRelease: async (payload) =>
            financial.push(payload),
        },
        logger: { warn: (message) => warnings.push(message), log: () => {} },
      },
    );
    const completing = cron.autoCompleteExpiredAcceptanceWindows();
    try {
      await waitForBlocked();
    } finally {
      release.resolve();
    }
    await complaint;
    await completing;
    assert.deepEqual(warnings, []);
    assert.equal(notices.length, 0);
    assert.equal(financial.length, 0);
    assert.equal(
      (await prisma.customOrder.findUniqueOrThrow({ where: { id: first.id } }))
        .status,
      'DELIVERED_PENDING_BUYER_CONFIRMATION',
    );
    evidence.cases.push(
      'complaint commits while cron waits: no completion, release or false notification',
    );

    const second = await createOrder();
    const completingHeld = deferred(),
      completingRelease = deferred();
    const completion = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "CustomOrder" WHERE "id"=${second.id}::uuid FOR UPDATE`;
        await tx.customOrder.update({
          where: { id: second.id },
          data: { status: 'COMPLETED' },
        });
        completingHeld.resolve();
        await completingRelease.promise;
      },
      { timeout: 15000 },
    );
    await completingHeld.promise;
    const reported = service.reportIssue(buyer.id, second.id, {
      issueType: 'WRONG_ITEM',
      description: 'Fixture',
      evidenceJson: { photos: ['https://example.invalid/proof.jpg'] },
    });
    const expectedRejection = assert.rejects(
      reported,
      /CUSTOM_ORDER_DISPUTE_WINDOW_CLOSED/,
    );
    try {
      await waitForBlocked();
    } finally {
      completingRelease.resolve();
    }
    await completion;
    await expectedRejection;
    assert.equal(
      await prisma.customOrderIssue.count({
        where: { customOrderId: second.id },
      }),
      0,
    );
    evidence.cases.push(
      'completion commits while complaint waits: post-lock window check rejects late complaint',
    );
    const otherBuyer = await prisma.user.create({
      data: {
        id: randomUUID(),
        username: 'other-refund-shopper',
        email: 'other-refund-shopper@example.invalid',
      },
    });
    const refundOrders = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        createOrder(index % 2 ? buyer.id : otherBuyer.id),
      ),
    );
    const attempt = await prisma.paymentAttempt.create({
      data: {
        buyerId: buyer.id,
        provider: 'PAYSTACK',
        providerMode: 'TEST',
        paymentMethod: 'PAYSTACK',
        status: 'PAID',
        reference: `refund-fixture-${randomUUID()}`,
        amount: 2600,
        currency: 'NGN',
        orderIds: [],
      },
    });
    await prisma.customOrderQueueRefund.createMany({
      data: refundOrders.map((order) => ({
        customOrderId: order.id,
        paymentAttemptId: attempt.id,
        amount: 100,
        currency: 'NGN',
        breakdownJson: {},
        status: 'SUBMITTING',
        lockedAt: new Date(Date.now() - 11 * 60000),
        nextAttemptAt: new Date(0),
      })),
    });
    let financialCalls = 0;
    const refunds = new CustomOrderQueueRefundsService(prisma, {
      postTransaction: async () => {
        financialCalls++;
        throw Error('Attention must not post money');
      },
    });
    queries.length = 0;
    const results = [
      await refunds.processPending(),
      await refunds.processPending(),
    ];
    assert.equal(
      results.reduce((sum, row) => sum + row.attention, 0),
      26,
    );
    const selectQueries = queries.filter((query) =>
      /^\s*SELECT\b/i.test(query),
    );
    evidence.refundAttentionContextJoinsFor26 = selectQueries.filter((query) =>
      /JOIN "CustomOrder"/.test(query),
    ).length;
    evidence.refundAttentionPaymentHydrationReadsFor26 = selectQueries.filter(
      (query) => /FROM "public"\."PaymentAttempt"/.test(query),
    ).length;
    assert.equal(evidence.refundAttentionContextJoinsFor26, 26);
    assert.equal(evidence.refundAttentionPaymentHydrationReadsFor26, 0);
    assert.equal(selectQueries.length, 30);
    const refundNotices = await prisma.customOrderNotificationOutbox.findMany({
      where: { customOrderId: { in: refundOrders.map((row) => row.id) } },
    });
    assert.equal(refundNotices.length, 26);
    for (const notice of refundNotices)
      assert.equal(
        notice.recipientId,
        refundOrders.find((order) => order.id === notice.customOrderId).buyerId,
      );
    assert.equal(
      await prisma.operationalAlert.count({
        where: { event: 'QUEUE_REFUND_NEEDS_ATTENTION' },
      }),
      26,
    );
    assert.equal(
      await prisma.paymentEvent.count({
        where: { type: 'CUSTOM_ORDER_QUEUE_REFUND_NEEDS_ATTENTION' },
      }),
      26,
    );
    assert.equal(
      await prisma.customOrderTimelineEvent.count({
        where: {
          customOrderId: { in: refundOrders.map((row) => row.id) },
          eventType: 'QUEUE_UPDATED',
        },
      }),
      26,
    );
    assert.equal(financialCalls, 0);
    evidence.cases.push(
      '26 stale refunds in two bounded sweeps retain fresh guarded transactions and use26 scalar context JOINs/zero payment hydration reads, correct buyer-isolated notices and durable alerts/events without financial/provider actions',
    );
    const completedRefund =
      await prisma.customOrderQueueRefund.findFirstOrThrow({
        where: { customOrderId: refundOrders[0].id },
      });
    queries.length = 0;
    assert.equal(
      await refunds.attention(completedRefund.id, 'fixture-replay', [
        'SUBMITTING',
      ]),
      false,
    );
    assert.equal(
      queries.filter((query) => /^\s*SELECT\b/i.test(query)).length,
      0,
    );
    assert.equal(
      await prisma.customOrderNotificationOutbox.count({
        where: { customOrderId: refundOrders[0].id },
      }),
      1,
    );
    evidence.cases.push(
      'a lost/refused attention claim does not reload context, repeat alerts/events or report a completed transition',
    );
    const rollbackOrder = await createOrder();
    const rollbackRefund = await prisma.customOrderQueueRefund.create({
      data: {
        customOrderId: rollbackOrder.id,
        paymentAttemptId: attempt.id,
        amount: 100,
        currency: 'NGN',
        breakdownJson: {},
        status: 'SUBMITTING',
      },
    });
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION refuse_attention_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Attention fixture rollback'; END $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER refuse_attention_fixture BEFORE INSERT ON "PaymentEvent" FOR EACH ROW EXECUTE FUNCTION refuse_attention_fixture()',
    );
    await assert.rejects(
      refunds.attention(rollbackRefund.id, 'fixture-failure', ['SUBMITTING']),
      /Attention fixture rollback/,
    );
    assert.equal(
      (
        await prisma.customOrderQueueRefund.findUniqueOrThrow({
          where: { id: rollbackRefund.id },
        })
      ).status,
      'SUBMITTING',
    );
    assert.equal(
      await prisma.operationalAlert.count({
        where: { dedupeKey: `queue-refund:${rollbackRefund.id}:attention` },
      }),
      0,
    );
    assert.equal(
      await prisma.customOrderNotificationOutbox.count({
        where: { customOrderId: rollbackOrder.id },
      }),
      0,
    );
    evidence.cases.push(
      'a real durable-event insert failure rolls back the attention state, alert and notification together',
    );
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER refuse_attention_fixture ON "PaymentEvent"',
    );
    await prisma.subscriptionTier.upsert({
      where: { key: 'THREAD' },
      create: {
        key: 'THREAD',
        name: 'Thread',
        monthlyPriceNgn: 10000,
        maxActive: 2,
        maxInDelivery: 3,
      },
      update: { maxActive: 2, maxInDelivery: 3 },
    });
    await prisma.brand.update({
      where: { id: brand.id },
      data: { verificationStatus: 'APPROVED', activeOrderCapOverride: null },
    });
    const queue = new CustomOrderQueueService(prisma, {}, {}, {});
    const capacityNow = new Date();
    queries.length = 0;
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).intakeAllowed,
      false,
    );
    evidence.capacitySelectsPerGuard = queries.filter((query) =>
      /^\s*SELECT\b/i.test(query),
    ).length;
    assert.equal(evidence.capacitySelectsPerGuard, 1);
    const agreement = await prisma.brandSubscription.create({
      data: {
        brandId: brand.id,
        tierKey: 'THREAD',
        priceSnapshotNgn: 10000,
        status: 'ACTIVE',
        currentPeriodStart: capacityNow,
        currentPeriodEnd: new Date(+capacityNow + 30 * 86400000),
      },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).intakeAllowed,
      true,
    );
    await prisma.brandSubscription.update({
      where: { id: agreement.id },
      data: { currentPeriodEnd: capacityNow },
    });
    const expiredCap = await queue.capacity(prisma, brand.id, capacityNow);
    assert.equal(expiredCap.intakeAllowed, false);
    assert.equal(expiredCap.safetyAllowed, true);
    await prisma.brandSubscription.update({
      where: { id: agreement.id },
      data: { currentPeriodEnd: new Date(+capacityNow + 30 * 86400000) },
    });
    await prisma.brand.update({
      where: { id: brand.id },
      data: {
        activeOrderCapOverride: 0,
        activeOrderCapOverrideUntil: new Date(+capacityNow + 1000),
      },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).active,
      0,
    );
    await prisma.brand.update({
      where: { id: brand.id },
      data: { activeOrderCapOverrideUntil: new Date(+capacityNow - 1000) },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).active,
      2,
    );
    await prisma.brand.update({
      where: { id: brand.id },
      data: { activeOrderCapOverride: null, activeOrderCapOverrideUntil: null },
    });
    const campaign = await prisma.capacityCampaign.create({
      data: {
        deltaActive: 2,
        startsAt: new Date(+capacityNow - 2 * 86400000),
        endsAt: new Date(+capacityNow - 86400000),
        resetMode: 'MANUAL',
        createdById: owner.id,
      },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).active,
      4,
    );
    await prisma.capacityCampaign.update({
      where: { id: campaign.id },
      data: { resetMode: 'AUTOMATIC' },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).active,
      2,
    );
    await prisma.subscriptionTier.update({
      where: { key: 'THREAD' },
      data: { maxActive: null, maxInDelivery: null },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).active,
      null,
    );
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).inDelivery,
      null,
    );
    await prisma.subscriptionTier.update({
      where: { key: 'THREAD' },
      data: { maxActive: 2, maxInDelivery: 3 },
    });
    await prisma.user.update({
      where: { id: owner.id },
      data: { status: 'SUSPENDED' },
    });
    assert.equal(
      (await queue.capacity(prisma, brand.id, capacityNow)).safetyAllowed,
      false,
    );
    await prisma.user.update({
      where: { id: owner.id },
      data: { status: 'ACTIVE' },
    });
    await assert.rejects(
      queue.capacity(prisma, randomUUID(), capacityNow),
      /Brand not found/,
    );
    evidence.cases.push(
      'one capacity JOIN per fresh guard preserves no-agreement intake refusal, exact expiry with paid-work safety, zero/expired overrides, manual/automatic campaigns, null unlimited caps, suspended owner and missing brand',
    );
    const settledOrders = await Promise.all(
      Array.from({ length: 26 }, () => createOrder()),
    );
    for (const [index, order] of settledOrders.entries())
      await prisma.customOrder.update({
        where: { id: order.id },
        data: {
          lane: 'PENDING',
          status: 'QUEUED',
          queuePolicyVersion: 1,
          queuePosition: index + 1,
          queuedAt: capacityNow,
          queueExpiresAt: new Date(+capacityNow + 86400000),
          buyerAcceptanceWindowEndsAt: null,
        },
      });
    await prisma.settlementPolicy.create({
      data: {
        orderType: 'CUSTOM_ORDER',
        scope: 'PLATFORM',
        currency: 'NGN',
        releaseMode: 'SPLIT_RELEASE',
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 60,
        isDefault: true,
        effectiveFrom: new Date(+capacityNow - 86400000),
      },
    });
    await prisma.commissionRule.create({
      data: {
        name: 'Queue fixture',
        scope: 'PLATFORM',
        currency: 'NGN',
        ratePercent: 10,
        isDefault: true,
        effectiveFrom: new Date(+capacityNow - 86400000),
      },
    });
    const config = {
      getNumber: async () => {
        throw Error('Actual fixture pricing must resolve from persisted rows');
      },
    };
    const ledger = new LedgerService(prisma);
    const finance = new CustomOrderFinanceSyncService(
      prisma,
      ledger,
      new SettlementCalculatorService(
        new SettlementPolicyService(prisma, config),
        new CommissionService(prisma, config),
      ),
      new SettlementSnapshotService(prisma),
    );
    const actualQueue = new CustomOrderQueueService(
      prisma,
      {},
      finance,
      ledger,
    );
    queries.length = 0;
    for (const order of settledOrders)
      await prisma.$transaction(async (tx) => {
        await actualQueue.lockBrand(tx, brand.id);
        await finance.applyPaidSettlement(tx, {
          customOrderId: order.id,
          brandId: brand.id,
          grossAmount: 100,
          currency: 'NGN',
          effectiveAt: capacityNow,
          releaseEligibleAt: capacityNow,
        });
      });
    evidence.customSettlementContextJoinsFor26 = queries.filter(
      (query) =>
        /^\s*SELECT\b/i.test(query) &&
        /FROM "CustomOrder" o/.test(query) &&
        /JOIN "Brand"/.test(query) &&
        /JOIN "User"/.test(query),
    ).length;
    evidence.customSettlementRelationHydrationFor26 = queries.filter(
      (query) =>
        /^\s*SELECT\b/i.test(query) &&
        /FROM "public"\."(?:CustomOrder|Brand|User)"/.test(query),
    ).length;
    assert.equal(evidence.customSettlementContextJoinsFor26, 26);
    assert.equal(evidence.customSettlementRelationHydrationFor26, 0);
    assert.equal(
      await prisma.customOrderLedgerAllocation.count({
        where: {
          customOrderId: { in: settledOrders.map((row) => row.id) },
          allocationType: 'PLACEMENT_CAPTURE',
          status: 'HELD',
        },
      }),
      26,
    );
    assert.equal(
      await prisma.customOrderLedgerAllocation.count({
        where: {
          customOrderId: { in: settledOrders.map((row) => row.id) },
          allocationType: 'BRAND_ACCEPTANCE_PORTION',
        },
      }),
      0,
    );
    evidence.cases.push(
      '26 actual paid waiting-order repairs use26 scalar order/brand/owner JOINs with zero relation hydration, preserve all placement captures and release no upfront funds before activation',
    );
    await prisma.$transaction(
      async (tx) => {
        const now = await actualQueue.lockBrand(tx, brand.id);
        await actualQueue.drain(tx, brand.id, now);
      },
      { timeout: 30000 },
    );
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'UP_NEXT' },
      }),
      1,
    );
    assert.equal(
      await prisma.customOrderLedgerAllocation.count({
        where: {
          customOrderId: { in: settledOrders.map((row) => row.id) },
          allocationType: 'BRAND_ACCEPTANCE_PORTION',
          status: 'PAYOUT_ELIGIBLE',
        },
      }),
      2,
    );
    await prisma.$transaction(async (tx) => {
      const now = await actualQueue.lockBrand(tx, brand.id);
      await actualQueue.drain(tx, brand.id, now);
    });
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    await prisma.user.update({
      where: { id: owner.id },
      data: { status: 'SUSPENDED' },
    });
    await prisma.$transaction(async (tx) => {
      const now = await actualQueue.lockBrand(tx, brand.id);
      await actualQueue.drain(tx, brand.id, now);
    });
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    evidence.cases.push(
      'real queue drain under brand lock respects two Active/one Up Next, activates only two financial releases, repeats without over-admission and stops safely after owner suspension',
    );
    await prisma.user.update({
      where: { id: owner.id },
      data: { status: 'ACTIVE' },
    });
    await prisma.customOrder.updateMany({
      where: { status: 'DELIVERED_PENDING_BUYER_CONFIRMATION' },
      data: { buyerAcceptanceWindowEndsAt: new Date(Date.now() + 86400000) },
    });
    const deliveryTarget = await prisma.customOrder.findFirstOrThrow({
      where: { brandId: brand.id, lane: 'ACTIVE' },
    });
    await prisma.customOrder.update({
      where: { id: deliveryTarget.id },
      data: {
        status: 'DELIVERED_PENDING_BUYER_CONFIRMATION',
        lane: 'IN_DELIVERY',
        buyerAcceptanceWindowEndsAt: new Date(Date.now() - 60000),
      },
    });
    const lifecycleNotices = [],
      lifecycleWarnings = [];
    const actualCron = Object.assign(
      Object.create(CustomOrderOpsCronService.prototype),
      {
        prisma,
        queue: actualQueue,
        ledgerService: ledger,
        sideEffects: {
          enqueueNotification: async (payload) =>
            lifecycleNotices.push(payload),
        },
        logger: {
          log() {},
          warn: (message) => lifecycleWarnings.push(message),
        },
      },
    );
    await actualCron.autoCompleteExpiredAcceptanceWindows();
    assert.deepEqual(lifecycleWarnings, []);
    assert.equal(
      (
        await prisma.customOrder.findUniqueOrThrow({
          where: { id: deliveryTarget.id },
        })
      ).status,
      'COMPLETED',
    );
    assert.equal(
      await prisma.customOrderLedgerAllocation.count({
        where: {
          customOrderId: deliveryTarget.id,
          allocationType: 'FINAL_COMPLETION_PORTION',
          status: 'PAYOUT_ELIGIBLE',
        },
      }),
      1,
    );
    assert.equal(
      await prisma.ledgerTransaction.count({
        where: { referenceType: 'CustomOrder', referenceId: deliveryTarget.id },
      }),
      3,
    );
    assert.equal(lifecycleNotices.length, 2);
    await actualCron.autoCompleteExpiredAcceptanceWindows();
    assert.equal(
      await prisma.ledgerTransaction.count({
        where: { referenceType: 'CustomOrder', referenceId: deliveryTarget.id },
      }),
      3,
    );
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    evidence.cases.push(
      'real timeout cron uses locked completion, queue drain/current capacity and a fresh held-allocation guard, records one final journal and buyer/owner notices, and replay posts no duplicate money',
    );
    const dispatchTarget = await prisma.customOrder.findFirstOrThrow({
      where: { brandId: brand.id, lane: 'ACTIVE' },
    });
    await prisma.customOrder.update({
      where: { id: dispatchTarget.id },
      data: { lane: 'IN_DELIVERY', status: 'IN_TRANSIT' },
    });
    await prisma.brandSubscription.update({
      where: { id: agreement.id },
      data: { currentPeriodEnd: capacityNow },
    });
    await prisma.$transaction(
      async (tx) => {
        const now = await actualQueue.lockBrand(tx, brand.id);
        await actualQueue.drain(tx, brand.id, now);
      },
      { timeout: 30000 },
    );
    assert.equal(
      (await actualQueue.capacity(prisma, brand.id)).intakeAllowed,
      false,
    );
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    await prisma.user.update({
      where: { id: owner.id },
      data: { status: 'SUSPENDED' },
    });
    queries.length = 0;
    await actualQueue.sweep();
    evidence.sweepCapacityJoins = queries.filter(
      (query) =>
        /^\s*SELECT\b/i.test(query) && /FROM "Brand" b JOIN "User"/.test(query),
    ).length;
    assert.equal(evidence.sweepCapacityJoins, 1);
    assert.equal(
      await prisma.customOrder.count({
        where: { brandId: brand.id, lane: 'ACTIVE' },
      }),
      2,
    );
    evidence.cases.push(
      'expired agreement blocks new intake while already-paid waiting work still promotes; actual cursor sweep performs one fresh capacity JOIN and respects a later owner suspension',
    );
    const priorityOrders = await Promise.all(Array.from({ length: 26 }, () => createOrder()));
    queries.length = 0;
    for (const row of priorityOrders) {
      const command = { ...row, jumpFeeAmount: new (require('@prisma/client').Prisma.Decimal)(20) };
      await prisma.$transaction(async (tx) => {
        await actualQueue.lockBrand(tx, brand.id);
        await actualQueue.releaseJump(tx, command);
        await actualQueue.releaseJump(tx, command);
      });
    }
    evidence.priorityAllocationReadsFor26Replayed = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."CustomOrderLedgerAllocation"/.test(query)).length;
    assert.equal(evidence.priorityAllocationReadsFor26Replayed, 0);
    const priorityIds = priorityOrders.map(row => row.id);
    const priorityAllocations = await prisma.customOrderLedgerAllocation.findMany({ where: { customOrderId: { in: priorityIds }, allocationType: 'JUMP_FEE' } });
    assert.equal(priorityAllocations.length, 26);
    assert(priorityAllocations.every(row => row.amount.toFixed(2) === '20.00' && row.commissionAmount.toFixed(2) === '2.00' && row.netBrandAmount.toFixed(2) === '18.00' && row.status === 'PAYOUT_ELIGIBLE'));
    assert.equal(await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrder', referenceId: { in: priorityIds }, idempotencyKey: { endsWith: ':jump_release' } } }), 26);
    const preserved = priorityAllocations[0];
    await prisma.customOrderLedgerAllocation.update({ where: { id: preserved.id }, data: { status: 'PAID_OUT', paidOutAt: new Date() } });
    await prisma.$transaction(async tx => actualQueue.releaseJump(tx, { ...priorityOrders[0], jumpFeeAmount: new (require('@prisma/client').Prisma.Decimal)(20) }));
    assert.equal((await prisma.customOrderLedgerAllocation.findUniqueOrThrow({ where: { id: preserved.id } })).status, 'PAID_OUT');
    evidence.cases.push('26 real priority-fee commands replay without allocation SELECTs, preserve existing payout status, record 26 unique allocations/journals and conserve 20 gross / 2 commission / 18 brand net');

    const cancellationQueue = new CustomOrderQueueService(prisma, new BrandPermissionService(prisma), finance, ledger);
    const prepareCancellationOrders = async expired => {
      const rows = await Promise.all(Array.from({ length: 26 }, () => createOrder()));
      const capture = await prisma.paymentAttempt.create({ data: { buyerId: buyer.id, provider: 'PAYSTACK', providerMode: 'TEST', paymentMethod: 'PAYSTACK', status: 'PAID', reference: `cancel-fixture-${randomUUID()}`, amount: 2600, currency: 'NGN', settlementAmount: 2600, settlementCurrency: 'NGN', orderIds: [] } });
      await prisma.customOrder.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { status: 'QUEUED', lane: 'PENDING', paymentReference: capture.reference, queueExpiresAt: new Date(Date.now() + (expired ? -3600000 : 86400000)), buyerAcceptanceWindowEndsAt: null, queuePolicyVersion: 1 } });
      await prisma.customOrderLedgerAllocation.createMany({ data: rows.map(row => ({ customOrderId: row.id, allocationType: 'PLACEMENT_CAPTURE', amount: 100, netBrandAmount: 100, currency: 'NGN', status: 'HELD' })) });
      return { rows, capture };
    };
    const bulkCancel = await prepareCancellationOrders(false);
    let presentations = 0;
    const originalPresent = cancellationQueue.present.bind(cancellationQueue);
    cancellationQueue.present = async (...args) => { presentations++; return originalPresent(...args); };
    queries.length = 0;
    const cancellationResults = await cancellationQueue.cancelMany(owner.id, brand.id, [...bulkCancel.rows.map(row => row.id), dispatchTarget.id], 'Regression bulk cancellation');
    evidence.bulkCancellationContextJoinsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "CustomOrder" o JOIN "Brand" b/.test(query)).length;
    assert.equal(evidence.bulkCancellationContextJoinsFor26, 27);
    assert.equal(presentations, 0);
    assert.equal(cancellationResults.results.filter(row => row.cancelled).length, 26);
    assert.equal(cancellationResults.results.find(row => row.id === dispatchTarget.id).cancelled, false);
    const bulkIds = bulkCancel.rows.map(row => row.id);
    assert.equal(await prisma.customOrderQueueRefund.count({ where: { customOrderId: { in: bulkIds }, kind: 'CANCELLATION' } }), 26);
    assert.equal(await prisma.customOrderLedgerAllocation.count({ where: { customOrderId: { in: bulkIds }, allocationType: 'PLACEMENT_CAPTURE', status: 'REVERSED' } }), 26);
    const bulkRefunds = await prisma.customOrderQueueRefund.findMany({ where: { customOrderId: { in: bulkIds } } });
    assert(bulkRefunds.every(row => row.breakdownJson.settlement.status === 'RECORDED' && row.breakdownJson.settlement.currency === 'NGN' && row.breakdownJson.settlement.amount === Number(row.amount)));
    const refundTotal = bulkRefunds.reduce((sum, row) => sum + Number(row.amount), 0);
    assert(refundTotal <= Number(bulkCancel.capture.amount));
    const recipients = await prisma.customOrderNotificationOutbox.findMany({ where: { customOrderId: { in: bulkIds }, payloadJson: { path: ['stage'], equals: 'QUEUE_CANCELLED' } } });
    assert.equal(recipients.length, 52);
    assert(recipients.every(row => row.recipientId === buyer.id || row.recipientId === owner.id));
    await assert.rejects(cancellationQueue.cancelMany(otherBuyer.id, brand.id, bulkIds, 'Unauthorized'), /permission/);
    await assert.rejects(cancellationQueue.cancelMany(owner.id, brand.id, [randomUUID()], 'Missing'), /do not belong/);
    await cancellationQueue.cancelMany(owner.id, brand.id, bulkIds, 'Replay');
    assert.equal(await prisma.customOrderQueueRefund.count({ where: { customOrderId: { in: bulkIds } } }), 26);
    assert.equal(presentations, 0);
    evidence.cases.push('bulk26 waiting cancellations plus one in-delivery refusal retain actual authorization, per-order payment/brand locks, captured-budget/refund FX records, 52 isolated durable notices and replay idempotency; zero unused response projections');

    const expiredCancel = await prepareCancellationOrders(true);
    queries.length = 0;
    await cancellationQueue.sweep();
    evidence.expiryCancellationContextJoinsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "CustomOrder" o JOIN "Brand" b/.test(query)).length;
    assert.equal(evidence.expiryCancellationContextJoinsFor26, 26);
    assert.equal(presentations, 0);
    const expiredIds = expiredCancel.rows.map(row => row.id);
    assert.equal(await prisma.customOrder.count({ where: { id: { in: expiredIds }, lane: 'TERMINAL', cancellationActorType: 'SYSTEM' } }), 26);
    assert.equal(await prisma.customOrderQueueRefund.count({ where: { customOrderId: { in: expiredIds } } }), 26);
    await cancellationQueue.sweep();
    assert.equal(await prisma.customOrderQueueRefund.count({ where: { customOrderId: { in: expiredIds } } }), 26);
    const publicResult = await cancellationQueue.cancel(buyer.id, expiredIds[0], 'Repeat from shopper');
    assert.equal(publicResult.queue.lane, 'TERMINAL');
    assert.equal(presentations, 1);
    evidence.cases.push('real expiry sweep cancels26 due orders with26 current order/owner JOINs, zero response projections and one refund each; replay is safe and public shopper cancellation still returns its queue response');
    const releaseOrders = await Promise.all(Array.from({ length: 26 }, () => createOrder()));
    const releaseIds = releaseOrders.map(row => row.id);
    await prisma.customOrder.updateMany({ where: { id: { in: releaseIds } }, data: { status: 'COMPLETED', lane: 'TERMINAL' } });
    // Earlier sections left eligible earnings. Record them as already paid out,
    // so this brand's position is exactly the release below.
    assert.equal(await prisma.brandBalanceAdjustment.count({ where: { brandId: brand.id, status: { in: ['OUTSTANDING', 'PARTIALLY_RECOVERED'] } } }), 0);
    const earlierPosition = (await loadBrandPosition(prisma, brand.id, 'NGN')).position;
    assert(!earlierPosition.isNegative());
    if (earlierPosition.greaterThan(0)) await prisma.payout.create({ data: { id: randomUUID(), brandId: brand.id, amount: earlierPosition, currency: 'NGN', status: 'PAID', reference: `fixture-${randomUUID()}` } });
    await prisma.customOrderLedgerAllocation.createMany({ data: releaseOrders.map(row => ({ customOrderId: row.id, allocationType: 'FINAL_COMPLETION_PORTION', amount: 10, commissionAmount: 1, netBrandAmount: 9, currency: 'NGN', status: 'PAYOUT_ELIGIBLE', eligibleAt: new Date() })) });
    // Manual debits reduce the position; refund clawbacks are a statement of refunds already netted there.
    const debts = await Promise.all(['10.01','4.99'].map((amount,index) => prisma.brandBalanceAdjustment.create({ data: { brandId: brand.id, type: 'MANUAL_DEBIT', amount, currency: 'NGN', reason: 'Debt query fixture', createdAt: new Date(Date.now() - (2-index)*3600000) } })));
    const balance = new BrandBalanceService(prisma);
    const adminFinance = Object.assign(Object.create(CustomOrderAdminService.prototype), { prisma, brandBalance: balance });
    const releaseAllocationIds = (await prisma.customOrderLedgerAllocation.findMany({ where: { customOrderId: { in: releaseIds } }, select: { id: true } })).map(row => row.id);
    queries.length = 0;
    const releaseResult = await adminFinance.releaseEligibleLedgerAllocations({ allocationIds: releaseAllocationIds }, owner.id);
    evidence.debtReadsFor26Allocations = queries.filter(query => /^\s*SELECT\b/i.test(query) && /BrandBalanceAdjustment/.test(query)).length;
    assert.equal(evidence.debtReadsFor26Allocations, 3, 'Position for the payable amount, the ordered debt lock and the position for recovery; nothing per allocation');
    assert.equal(releaseResult.data.releasedBatches, 1);
    assert.equal(releaseResult.data.releasedAllocations, 26);
    assert.equal(releaseResult.data.appliedToBrandDebt, 15);
    const debtPayouts = await prisma.payout.findMany({ where: { brandId: brand.id, status: 'PENDING_APPROVAL' } });
    assert.equal(debtPayouts.length, 1);
    assert.equal(debtPayouts[0].amount.toFixed(2), '219.00');
    assert.equal(await prisma.brandBalanceAdjustment.count({ where: { id: { in: debts.map(row => row.id) }, status: 'RECOVERED' } }), 2);
    assert.equal(await prisma.brandBalanceRecovery.count({ where: { adjustmentId: { in: debts.map(row => row.id) } } }), 2);
    const releaseReplay = await adminFinance.releaseEligibleLedgerAllocations({ allocationIds: releaseAllocationIds }, owner.id);
    assert.equal(releaseReplay.data.releasedAllocations, 0);
    assert.equal(await prisma.payout.count({ where: { brandId: brand.id, status: 'PENDING_APPROVAL' } }), 1);
    assert.equal(await prisma.brandBalanceRecovery.count({ where: { adjustmentId: { in: debts.map(row => row.id) } } }), 2);
    evidence.cases.push('actual admin release groups26 NGN allocations into one payout capped by the brand position: two manual debits totalling15 settle first (oldest-first, one statement line each) before a219 payout, with three bounded debt reads; replay pays and recovers nothing twice');
    await prisma.brandBalanceAdjustment.createMany({ data: [
      { brandId: brand.id, type: 'MANUAL_DEBIT', amount: 20, recoveredAmount: 0, currency: 'NGN', reason: 'Summary fixture', createdAt: new Date(Date.now() - 7200000) },
      { brandId: brand.id, type: 'MANUAL_CREDIT', amount: 5, recoveredAmount: 0, currency: 'NGN', reason: 'Summary credit fixture' },
    ] });
    const openDebit = await prisma.brandBalanceAdjustment.findFirstOrThrow({ where: { brandId: brand.id, status: 'OUTSTANDING', type: 'MANUAL_DEBIT' } });
    queries.length = 0;
    assert.deepEqual(await balance.getDebtSnapshot(brand.id), { outstanding: 15, currency: 'NGN', count: 1, oldestAt: openDebit.createdAt, inDebt: true });
    evidence.debtSummaryContextReads = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "Brand" b/.test(query) && /BrandBalanceAdjustment/.test(query)).length;
    assert.equal(evidence.debtSummaryContextReads, 1);
    assert.deepEqual(await balance.getDebtSnapshot(randomUUID()), { outstanding: 0, currency: 'NGN', count: 0, oldestAt: null, inDebt: false });
    const balanceNotices = [];
    const balanceWithNotices = new BrandBalanceService(prisma, { create: async (...args) => { balanceNotices.push(args); } });
    while ((await balanceWithNotices.announcePending()) > 0);
    assert.equal(await balanceWithNotices.announcePending(), 0);
    const ownerNotices = balanceNotices.filter(args => args[0] === owner.id);
    const brandRows = (await prisma.brandBalanceAdjustment.count({ where: { brandId: brand.id } })) + (await prisma.brandBalanceRecovery.count({ where: { adjustment: { brandId: brand.id } } }));
    assert.equal(ownerNotices.length, brandRows);
    assert(ownerNotices.every(args => args[2].payload.outstanding === 15));
    assert.equal(new Set(balanceNotices.map(args => args[2].notificationId)).size, balanceNotices.length);
    evidence.debtNoticesSent = balanceNotices.length;
    evidence.cases.push('position-based debt snapshot (manual credit nets, missing brand defaults) in one owner/debt JOIN; owner notices are sent once per committed adjustment or recovery, after commit, each with the current outstanding amount');
    await prisma.user.update({ where: { id: owner.id }, data: { status: 'ACTIVE' } });
    await prisma.brand.update({ where: { id: brand.id }, data: { activeOrderCapOverride: 0, activeOrderCapOverrideUntil: new Date(Date.now() + 86400000) } });
    await prisma.brandSubscription.update({ where: { id: agreement.id }, data: { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
    const admissionOrders = await Promise.all(Array.from({ length: 26 }, () => createOrder()));
    const admissionIds = admissionOrders.map(row => row.id);
    const admissionCapture = await prisma.paymentAttempt.create({ data: { buyerId: buyer.id, provider: 'PAYSTACK', providerMode: 'test', paymentMethod: 'PAYSTACK', status: 'PAID', reference: `admission-fixture-${randomUUID()}`, amount: 2600, currency: 'NGN', orderIds: [] } });
    await prisma.customOrder.updateMany({ where: { id: { in: admissionIds } }, data: { status: 'PENDING_BRAND_ACCEPTANCE', lane: null, paymentReference: admissionCapture.reference, buyerAcceptanceWindowEndsAt: null } });
    queries.length = 0;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PaymentAttempt" WHERE id = ${admissionCapture.id}::uuid FOR UPDATE`;
      for (const row of admissionOrders) await actualQueue.admitPaid(tx, row.id);
    }, { timeout: 30000 });
    evidence.admissionBrandMetadataReadsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."Brand"/.test(query)).length;
    assert.equal(evidence.admissionBrandMetadataReadsFor26, 0);
    assert.equal(await prisma.customOrder.count({ where: { id: { in: admissionIds }, lane: { in: ['PENDING','UP_NEXT'] } } }), 26);
    assert.equal(await prisma.customOrder.count({ where: { id: { in: admissionIds }, lane: 'ACTIVE' } }), 0);
    assert.equal(await prisma.customOrderLedgerAllocation.count({ where: { customOrderId: { in: admissionIds }, allocationType: 'PLACEMENT_CAPTURE', status: 'HELD' } }), 26);
    const reminderCount = await prisma.customOrderNotificationOutbox.count({ where: { customOrderId: { in: admissionIds }, OR: [48,24,5].map(hours => ({ payloadJson: { path: ['stage'], equals: `QUEUE_EXPIRY_${hours}` } })) } });
    assert.equal(reminderCount, 156);
    const placementNotices = await prisma.customOrderNotificationOutbox.findMany({ where: { customOrderId: { in: admissionIds }, payloadJson: { path: ['stage'], equals: 'QUEUE_PLACED' } } });
    assert.equal(placementNotices.length, 52);
    assert(placementNotices.every(row => row.recipientId === owner.id || row.recipientId === buyer.id));
    const admissionJournals = await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrder', referenceId: { in: admissionIds } } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "PaymentAttempt" WHERE id = ${admissionCapture.id}::uuid FOR UPDATE`;
      for (const row of admissionOrders) await actualQueue.admitPaid(tx, row.id);
    }, { timeout: 30000 });
    assert.equal(await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrder', referenceId: { in: admissionIds } } }), admissionJournals);
    assert.equal(await prisma.customOrderNotificationOutbox.count({ where: { customOrderId: { in: admissionIds }, OR: [48,24,5].map(hours => ({ payloadJson: { path: ['stage'], equals: `QUEUE_EXPIRY_${hours}` } })) } }), 156);
    evidence.cases.push('26 paid admissions under their shared capture transaction perform zero standalone brand metadata reads, retain26 held captures at zero Active capacity,52placement notices/156expiry reminders and replay without duplicate money or reminders');
    {
      const makeRefundPage = async (mode, status) => {
        const rows = await Promise.all(Array.from({ length: 26 }, () => createOrder()));
        const capture = await prisma.paymentAttempt.create({ data: { buyerId: buyer.id, provider: 'PAYSTACK', providerMode: mode, paymentMethod: 'PAYSTACK', reference: `context-refund-${randomUUID()}`, amount: 2600, settlementAmount: 2600, settlementCurrency: 'NGN', currency: 'NGN', status: 'PAID', orderIds: [] } });
        await prisma.customOrder.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { paymentReference: capture.reference, lane: 'TERMINAL', status: 'REFUND_IN_PROGRESS', cancelledAt: new Date(), buyerAcceptanceWindowEndsAt: null } });
        await prisma.customOrderQueueRefund.createMany({ data: rows.map((row,index) => ({ customOrderId: row.id, paymentAttemptId: capture.id, status, amount: 97, currency: 'NGN', providerRefundId: status === 'PROCESSING' ? `fixture-provider-${index}-${randomUUID()}` : null, lockedAt: status === 'PROCESSING' ? new Date() : null, nextAttemptAt: new Date(0), breakdownJson: { currency: 'NGN', captureAmount: 100, vatAmount: 0, garmentCharge: 3, jumpCharge: 0, refundAmount: 97, settlement: { status: 'RECORDED', amount: 97, currency: 'NGN', rate: '1', exchangeRateSnapshotId: null, rounding: 'CUMULATIVE_HALF_UP' } } })) });
        return { capture, orders: rows, refunds: await prisma.customOrderQueueRefund.findMany({ where: { paymentAttemptId: capture.id }, orderBy: { createdAt: 'asc' } }) };
      };
      const mockRefunds = await makeRefundPage('mock', 'REQUESTED');
      await prisma.customOrderQueueRefund.updateMany({ where: { paymentAttemptId: { not: mockRefunds.capture.id } }, data: { nextAttemptAt: new Date(Date.now() + 86400000) } });
      const processor = new CustomOrderQueueRefundsService(prisma, ledger);
      let unexpectedTransport = 0;
      processor.secret = () => { unexpectedTransport++; throw Error('Transport must not run in DB-only guarded scenarios'); };
      const mockConfig = { NODE_ENV: process.env.NODE_ENV, CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED: process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED };
      process.env.NODE_ENV = 'test'; process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED = 'true';
      try {
        queries.length = 0;
        assert.deepEqual(await processor.processPending(20), { processed: 20, attention: 0 });
        assert.deepEqual(await processor.processPending(20), { processed: 6, attention: 0 });
        evidence.refundJoinedContextReadsFor26 = queries.filter(query => /^\s*SELECT r\.\*/.test(query) && /JOIN "PaymentAttempt"/.test(query) && /JOIN "CustomOrder"/.test(query)).length;
        evidence.refundRelatedHydrationReadsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."(?:PaymentAttempt|CustomOrder)"/.test(query)).length;
        assert.equal(evidence.refundJoinedContextReadsFor26, 78);
        assert.equal(evidence.refundRelatedHydrationReadsFor26, 0);
        assert.equal(await prisma.customOrderQueueRefund.count({ where: { paymentAttemptId: mockRefunds.capture.id, status: 'SETTLED' } }), 26);
        assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: mockRefunds.capture.id } })).status, 'PAID');
        assert.equal(await prisma.customOrder.count({ where: { id: { in: mockRefunds.orders.map(row => row.id) }, status: 'CLOSED', paymentStatus: 'REFUNDED' } }), 26);
        assert.equal(await prisma.customOrderNotificationOutbox.count({ where: { customOrderId: { in: mockRefunds.orders.map(row => row.id) }, payloadJson: { path: ['stage'], equals: 'QUEUE_REFUND_PROCESSED' }, recipientId: buyer.id } }), 26);
        const completedJournals = await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrderQueueRefund', type: 'REFUND_ISSUED', referenceId: { in: mockRefunds.refunds.map(row => row.id) } } });
        assert.equal(completedJournals, 26);
        assert.deepEqual(await processor.processPending(20), { processed: 0, attention: 0 });
        assert.equal(await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrderQueueRefund', type: 'REFUND_ISSUED', referenceId: { in: mockRefunds.refunds.map(row => row.id) } } }), completedJournals);
      } finally { for(const [key,value] of Object.entries(mockConfig)){if(value===undefined)delete process.env[key];else process.env[key]=value;} }
      assert.equal(unexpectedTransport, 0);
      evidence.cases.push('26 explicit internal-simulation refunds execute real claims/reservations/ledger/completion with78scalar context JOINs/zero eager payment-order hydration, leave parent capture paid, notify correct buyers and replay safely; no provider transport is reached');
      const callbackRefunds = await makeRefundPage('test', 'PROCESSING');
      queries.length = 0;
      const accepted = await processor.handleWebhook('PAYSTACK', { event: 'refund.processed', data: { transaction_reference: callbackRefunds.capture.reference } });
      assert.equal(accepted, true);
      evidence.refundWebhookBatchContextReads = queries.filter(query => /^\s*SELECT r\.\*/.test(query)).length;
      assert.equal(evidence.refundWebhookBatchContextReads, 1);
      assert.equal(unexpectedTransport, 0);
      assert.equal(await prisma.customOrderQueueRefund.count({ where: { paymentAttemptId: callbackRefunds.capture.id, status: 'PROCESSING' } }), 26);
      assert.equal(await processor.handleWebhook('FLUTTERWAVE', { event: 'refund.processed', data: { transaction_reference: callbackRefunds.capture.reference } }), false);
      assert.deepEqual(await loadQueueRefundContexts(prisma, { id: randomUUID() }), []);
      const [callbackContext] = await loadQueueRefundContexts(prisma, { id: callbackRefunds.refunds[0].id });
      assert.equal(callbackContext.amount.toFixed(2), '97.00');
      assert.equal(callbackContext.paymentAttempt.amount.toFixed(2), '2600.00');
      assert.equal(callbackContext.paymentAttempt.settlementAmount.toFixed(2), '2600.00');
      assert.equal(callbackContext.customOrder.buyerId, buyer.id);
      evidence.cases.push('reference-only webhook loads its bounded20equal-price siblings in one JOIN, respects existing poll leases without transport, excludes the wrong gateway and preserves native capture/refund values and missing-ID behavior');
      const callbackRow = callbackRefunds.refunds[0];
      await prisma.$transaction(tx => processor.reserve(tx, callbackContext));
      const callbackPayload = { event: 'refund.processed', data: { id: callbackRow.providerRefundId, status: 'processed', amount: 9700, currency: 'NGN', transaction: { reference: callbackRefunds.capture.reference } } };
      await processor.handleWebhook('PAYSTACK', callbackPayload);
      assert.equal((await prisma.customOrderQueueRefund.findUniqueOrThrow({ where: { id: callbackRow.id } })).status, 'SETTLED');
      await processor.handleWebhook('PAYSTACK', callbackPayload);
      assert.equal(await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrderQueueRefund', type: 'REFUND_ISSUED', referenceId: callbackRow.id } }), 1);
      const mismatched = callbackRefunds.refunds[1];
      await processor.handleWebhook('PAYSTACK', { event: 'refund.processed', data: { ...callbackPayload.data, id: mismatched.providerRefundId, amount: 1 } });
      assert.equal((await prisma.customOrderQueueRefund.findUniqueOrThrow({ where: { id: mismatched.id } })).status, 'NEEDS_ATTENTION');
      assert.equal(await prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrderQueueRefund', type: 'REFUND_ISSUED', referenceId: mismatched.id } }), 0);
      assert.equal(unexpectedTransport, 0);
      evidence.cases.push('trusted provider-ID callback uses current joined identity, settles only its reserved sibling once, preserves parent paid state and escalates a wrong amount without refund journal; central signature and live polling remain separate gates');
    }
    if (process.env.CUSTOM_PAYMENT_PROVIDER_SIM_URL) {
      const proof = await require('./custom-payment-provider-scenarios.cjs')({ prisma, queries, simulationUrl: process.env.CUSTOM_PAYMENT_PROVIDER_SIM_URL, buyer, owner, brand, agreement, finance, queue: actualQueue, createOrder });
      evidence.cases.push(...proof.cases);
      evidence.customPaymentProvider = { ...proof, cases: undefined };
      const unifiedProof = await require('./unified-checkout-query-scenarios.cjs')({ prisma, queries, buyer, owner, brand, configuration, version, finance, queue: actualQueue });
      evidence.cases.push(...unifiedProof.cases);
      evidence.unifiedCheckoutQuery = { ...unifiedProof, cases: undefined };
    }
    const extensionProof=await require('./extension-concurrency-scenarios.cjs')({prisma,buyer,owner,brand,createOrder,waitForBlocked,ledger,queue:actualQueue});
    evidence.cases.push(...extensionProof.cases);
    evidence.extensions={...extensionProof,cases:undefined};
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_issue_race_[a-f0-9]{32}$/.test(database));
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await admin.query(`DROP DATABASE "${database}"`);
      evidence.cleanupPassed = true;
    }
    await admin.end();
    await fs.writeFile(
      path.resolve(
        __dirname,
        '../docs/performance-reviews/custom-order-issue-race-postgres-2026-10-23.json',
      ),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error) => {
  const required = String(error.message || '').match(
    /Argument `[^`]+` is missing|Invalid value for argument[^\n]*|Invalid value for argument[^\n]*/g,
  );
  console.error(
    error.code || error.name || 'Custom-order issue race fixture failed',
    required ||
      (error instanceof TypeError || error instanceof assert.AssertionError
        ? error.message
        : 'Fixture failed; no connection details logged'),
  );
  process.exitCode = 1;
});
