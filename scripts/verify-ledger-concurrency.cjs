// Generated Prisma and actual LedgerService in a disposable PostgreSQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
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
const {
  StandardOrderEscrowService,
} = require('../src/finance/standard-order-escrow.service');
const {
  StandardOrderFinanceSyncService,
} = require('../src/finance/standard-order-finance-sync.service');
const {
  FinancialDocumentsService,
} = require('../src/finance/financial-documents.service');
const {
  SettlementBackfillService,
} = require('../src/finance/settlement-backfill.service');
const {
  SubscriptionsService,
} = require('../src/subscriptions/subscriptions.service');
const { BrandAccessService } = require('../src/brands/brand-access.service');
const { OrderRefundService } = require('../src/order/order-refund.service');
const { OrderSlaCronService } = require('../src/order/order-sla.cron.service');
const { loadStandardOrderRefundContext } = require('../src/order/order-refund-query');
const { PaymentService } = require('../src/payment/payment.service');
const { FxRateService } = require('../src/payment/fx-rate.service');
const { lockPaymentAttempt } = require('../src/payment/payment-attempt-query');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback database required',
  );
  const database = `wiez_ledger_race_${randomUUID().replaceAll('-', '')}`;
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
    for (let i = 0; i < 500; i++) {
      const result = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`,
        [database],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error(
      'Expected competing ledger writer to wait for the database lock',
    );
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
    const queries = [];
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString(), max: 10 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (event) => queries.push(event.query));
    if (process.env.SUBSCRIPTION_PROVIDER_SIM_URL) {
      evidence.subscriptionProvider = await require('./subscription-provider-scenarios.cjs')(prisma, queries, process.env.SUBSCRIPTION_PROVIDER_SIM_URL);
      evidence.cases.push(...evidence.subscriptionProvider.cases);
    }
    const ledger = new LedgerService(prisma);
    const params = (key, amount = 1, reverse = false, prefix = 'shared') => ({
      idempotencyKey: key,
      type: 'PAYMENT_RECEIVED',
      description: 'Concurrency fixture',
      totalAmount: amount,
      currency: 'NGN',
      lines: (reverse ? ['B', 'A'] : ['A', 'B']).map((code) => ({
        code: `${prefix}:${code}`,
        name: code,
        type: 'ASSET',
        subType: 'FIXTURE',
        isSystemAccount: true,
        direction: code === 'A' ? 'DEBIT' : 'CREDIT',
        amount,
      })),
    });
    const post = (input) =>
      prisma.$transaction((tx) => ledger.postTransaction(tx, input), {
        timeout: 20000,
        maxWait: 20000,
        isolationLevel: 'ReadCommitted',
      });

    const held = deferred(),
      release = deferred();
    const first = prisma.$transaction(
      async (tx) => {
        const result = await ledger.postTransaction(tx, params('same-key', 7));
        held.resolve();
        await release.promise;
        return result;
      },
      { timeout: 20000 },
    );
    await held.promise;
    const second = post(params('same-key', 7));
    try {
      await waitForBlocked();
    } finally {
      release.resolve();
    }
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.id, two.id);
    assert.equal(two.entries.length, 2);
    assert.equal(await prisma.ledgerTransaction.count(), 1);
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'shared:A' },
        })
      ).currentBalance.toFixed(2),
      '7.00',
    );
    evidence.cases.push(
      'competing duplicate key waits, replays complete winner and posts once',
    );

    await assert.rejects(
      post(params('same-key', 8)),
      /LEDGER_IDEMPOTENCY_CONFLICT/,
    );
    assert.equal(await prisma.ledgerEntry.count(), 2);
    evidence.cases.push(
      'same key with a different amount fails without extra entries',
    );

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        post(params(`cold:${i}`, 1, i % 2 === 0, 'cold')),
      ),
    );
    assert.equal(
      await prisma.ledgerAccount.count({
        where: { code: { startsWith: 'cold:' } },
      }),
      2,
    );
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'cold:A' },
        })
      ).currentBalance.toFixed(2),
      '30.00',
    );
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'cold:B' },
        })
      ).currentBalance.toFixed(2),
      '-30.00',
    );
    assert.equal(
      await prisma.ledgerEntry.count({
        where: { account: { code: { startsWith: 'cold:' } } },
      }),
      60,
    );
    evidence.cases.push(
      'thirty cold-account postings with opposite line order retain every cent without deadlock',
    );

    const rollbackBefore = await prisma.ledgerAccount.findUniqueOrThrow({
      where: { code: 'cold:A' },
    });
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await ledger.postTransaction(tx, params('rollback', 11, false, 'cold'));
        throw Error('Fixture rollback');
      }),
      /Fixture rollback/,
    );
    assert.equal(
      await prisma.ledgerTransaction.count({
        where: { idempotencyKey: 'rollback' },
      }),
      0,
    );
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'cold:A' },
        })
      ).currentBalance.toFixed(2),
      rollbackBefore.currentBalance.toFixed(2),
    );
    evidence.cases.push(
      'outer transaction rollback removes claim, entries and balance changes together',
    );

    await prisma.ledgerAccount.update({
      where: { code: 'cold:A' },
      data: { currentBalance: new Prisma.Decimal('999999999999999.90') },
    });
    await post(params('precision', 0.01, false, 'cold'));
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'cold:A' },
        })
      ).currentBalance.toFixed(2),
      '999999999999999.91',
    );
    evidence.cases.push(
      'large stored decimal balance retains a one-cent increment',
    );

    const repeated = params('repeated', 3, false, 'cold');
    repeated.lines = [
      { ...repeated.lines[0], amount: 1 },
      { ...repeated.lines[0], amount: 2 },
      repeated.lines[1],
    ];
    const repeatedResult = await post(repeated);
    const snapshots = repeatedResult.entries
      .filter((entry) => entry.account.code === 'cold:A')
      .map((entry) => entry.balanceAfter.toFixed(2))
      .sort();
    assert.deepEqual(snapshots, ['1000000000000000.91', '1000000000000002.91']);
    evidence.cases.push(
      'repeated account lines preserve each intermediate balance snapshot',
    );

    for (const amount of [-1, NaN, Infinity])
      await assert.rejects(
        post(params(`invalid:${String(amount)}`, amount)),
        /LEDGER_INVALID_AMOUNT/,
      );
    const unbalanced = params('unbalanced');
    unbalanced.lines[1].amount = 2;
    await assert.rejects(post(unbalanced), /LEDGER_UNBALANCED_TRANSACTION/);
    const mismatch = params('definition-mismatch', 1, false, 'cold');
    mismatch.lines[0].type = 'LIABILITY';
    await assert.rejects(post(mismatch), /LEDGER_ACCOUNT_DEFINITION_MISMATCH/);
    assert.equal(
      await prisma.ledgerTransaction.count({
        where: {
          idempotencyKey: {
            in: [
              'invalid:-1',
              'invalid:NaN',
              'invalid:Infinity',
              'unbalanced',
              'definition-mismatch',
            ],
          },
        },
      }),
      0,
    );
    evidence.cases.push(
      'non-finite, negative, unbalanced and mismatched-account input rolls back',
    );

    await post(params('warm-up', 1, false, 'bounded'));
    queries.length = 0;
    const many = params('bounded-lines', 20, false, 'bounded');
    many.lines = Array.from({ length: 20 }, () => params('unused').lines)
      .flat()
      .map((line) => ({
        ...line,
        code: line.code.replace('shared:', 'bounded:'),
      }));
    await post(many);
    const accountReads = queries.filter((query) =>
      /SELECT[\s\S]*FROM\s+"(?:public"\.")?LedgerAccount"/i.test(query),
    );
    // findMany + ordered lock; returned transaction may hydrate accounts once.
    assert(
      accountReads.length <= 3,
      `Forty ledger lines caused ${accountReads.length} account reads`,
    );
    assert.equal(
      (
        await prisma.ledgerAccount.findUniqueOrThrow({
          where: { code: 'bounded:A' },
        })
      ).currentBalance.toFixed(2),
      '21.00',
    );
    evidence.cases.push(
      `forty lines use bounded account reads (${accountReads.length}) and batch entries/balances`,
    );
    {
      const ownerId = randomUUID(),
        buyerId = randomUUID(),
        brandId = randomUUID();
      await prisma.user.createMany({
        data: [ownerId, buyerId].map((id) => ({
          id,
          username: id,
          email: `${id}@example.invalid`,
        })),
      });
      await prisma.brand.create({
        data: { id: brandId, ownerId, name: 'Settlement fixture' },
      });
      const policy = await prisma.settlementPolicy.create({
        data: {
          orderType: 'STANDARD_ORDER',
          scope: 'PLATFORM',
          currency: 'NGN',
          releaseMode: 'SPLIT_RELEASE',
          upfrontReleaseEnabled: true,
          upfrontReleasePercent: 30,
          isDefault: true,
          effectiveFrom: new Date('2000-01-01T00:00:00Z'),
        },
      });
      const commission = await prisma.commissionRule.create({
        data: {
          name: 'Fixture',
          scope: 'PLATFORM',
          currency: 'NGN',
          ratePercent: 10,
          isDefault: true,
          effectiveFrom: new Date('2000-01-01T00:00:00Z'),
        },
      });
      const config = {
        getNumber: async () => {
          throw Error('Persisted fixture policy/rules must be selected');
        },
      };
      const calculator = new SettlementCalculatorService(
        new SettlementPolicyService(prisma, config),
        new CommissionService(prisma, config),
      );
      const snapshots = new SettlementSnapshotService(prisma);
      const escrow = new StandardOrderEscrowService(
        prisma,
        config,
        ledger,
        calculator,
        snapshots,
        {},
      );
      const paidOrders = Array.from({ length: 26 }, () => ({
        id: randomUUID(),
        brandId,
        buyerId,
        customerName: 'Settlement fixture',
        items: [],
        totalAmount: new Prisma.Decimal(100),
        currency: 'NGN',
        paymentStatus: 'PAID',
      }));
      await prisma.order.createMany({ data: paidOrders });
      queries.length = 0;
      await prisma.$transaction(
        (tx) => escrow.ensureHoldsForPaidOrders(tx, paidOrders, 2600, 'NGN'),
        { timeout: 30000 },
      );
      const reads = queries.filter((query) => /^\s*SELECT\b/i.test(query));
      evidence.freshSettlementSnapshotReadsFor26 = reads.filter((query) =>
        /FROM "public"\."settlement_snapshot"/.test(query),
      ).length;
      evidence.freshSettlementHoldReadsFor26 = reads.filter((query) =>
        /FROM "public"\."EscrowHold"/.test(query),
      ).length;
      evidence.freshSettlementSnapshotInsertsFor26 = queries.filter((query) =>
        /INSERT INTO "public"\."settlement_snapshot"/.test(query),
      ).length;
      assert.equal(evidence.freshSettlementSnapshotReadsFor26, 0);
      assert.equal(evidence.freshSettlementHoldReadsFor26, 0);
      assert.equal(evidence.freshSettlementSnapshotInsertsFor26, 1);
      assert.equal(
        await prisma.escrowHold.count({
          where: {
            brandId,
            status: 'PARTIALLY_RELEASED',
            firstReleasedAt: { not: null },
          },
        }),
        26,
      );
      const payments = await prisma.ledgerTransaction.findMany({
        where: { referenceId: { in: paidOrders.map((row) => row.id) } },
        select: { id: true },
      });
      assert.equal(payments.length, 52);
      const originalSnapshots = await prisma.settlementSnapshot.findMany({
        where: { brandId },
      });
      assert.equal(originalSnapshots.length, 26);
      assert(
        originalSnapshots.every(
          (row) =>
            row.commissionRate.toFixed(2) === '10.00' &&
            row.upfrontReleasePercent.toFixed(2) === '30.00' &&
            row.calculatedAt instanceof Date,
        ),
      );
      evidence.cases.push(
        '26 real split-release paid orders create snapshots in one INSERT with zero snapshot/hold reloads; canonical policy/commission JOINs,52 independent ledger postings and release flags preserved',
      );
      await prisma.settlementPolicy.update({
        where: { id: policy.id },
        data: { upfrontReleasePercent: 80 },
      });
      await prisma.commissionRule.update({
        where: { id: commission.id },
        data: { ratePercent: 50 },
      });
      queries.length = 0;
      await prisma.$transaction(
        (tx) => escrow.ensureHoldsForPaidOrders(tx, paidOrders, 2600, 'NGN'),
        { timeout: 30000 },
      );
      evidence.replayedSettlementSnapshotReadsFor26 = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /FROM "public"\."settlement_snapshot"/.test(query),
      ).length;
      assert.equal(evidence.replayedSettlementSnapshotReadsFor26, 1);
      assert.equal(
        await prisma.ledgerTransaction.count({
          where: { referenceId: { in: paidOrders.map((row) => row.id) } },
        }),
        52,
      );
      const replayed = await prisma.settlementSnapshot.findMany({
        where: { brandId },
      });
      assert.deepEqual(
        replayed.map((row) => row.id).sort(),
        originalSnapshots.map((row) => row.id).sort(),
      );
      assert(
        replayed.every(
          (row) =>
            row.commissionRate.toFixed(2) === '10.00' &&
            row.upfrontReleasePercent.toFixed(2) === '30.00',
        ),
      );
      evidence.cases.push(
        'replaying26 settlements uses one shared conflict lookup, preserves immutable original commission/release terms and posts no duplicate money',
      );
      await prisma.order.updateMany({
        where: { id: { in: paidOrders.map((row) => row.id) } },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(Date.now() - 8 * 86400000),
        },
      });
      queries.length = 0;
      const confirmed = await escrow.autoConfirmDeliveredOrders();
      evidence.deliveryConfirmationJoinedScansFor26 = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /JOIN "Order"/.test(query) &&
          /JOIN "settlement_snapshot"/.test(query),
      ).length;
      evidence.deliveryConfirmationSnapshotReloadsFor26 = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /FROM "public"\."settlement_snapshot"/.test(query),
      ).length;
      assert.equal(confirmed, 26);
      assert.equal(evidence.deliveryConfirmationJoinedScansFor26, 1);
      assert.equal(evidence.deliveryConfirmationSnapshotReloadsFor26, 0);
      assert.equal(
        await prisma.escrowHold.count({
          where: {
            brandId,
            secondReleaseCondition: 'BUYER_TIMEOUT',
            secondReleaseEligibleAt: {
              gt: new Date(Date.now() + 47 * 3600000),
            },
          },
        }),
        26,
      );
      evidence.cases.push(
        '26 delivery timeouts use one hold/order/snapshot JOIN and zero snapshot reloads while retaining per-order current-hold guards and original48-hour delay',
      );
      await prisma.escrowHold.updateMany({
        where: { brandId },
        data: { secondReleaseEligibleAt: new Date(Date.now() - 1000) },
      });
      assert.equal(await escrow.releaseEligibleFinalPortions(), 26);
      assert.equal(
        await prisma.escrowHold.count({
          where: {
            brandId,
            status: 'RELEASED',
            secondReleasedAt: { not: null },
          },
        }),
        26,
      );
      assert.equal(
        await prisma.ledgerTransaction.count({
          where: { referenceId: { in: paidOrders.map((row) => row.id) } },
        }),
        78,
      );
      assert.equal(await escrow.releaseEligibleFinalPortions(), 0);
      evidence.cases.push(
        '26 independent final-release commands retain one ledger posting each; a repeated sweep finds no due holds and posts no duplicate money',
      );
      const receiptReferences = [
        `fixture-${randomUUID()}`,
        `fixture-${randomUUID()}`,
      ];
      for (const [index, reference] of receiptReferences.entries()) {
        const ids = paidOrders
          .slice(index * 13, index * 13 + 13)
          .map((row) => row.id);
        await prisma.order.updateMany({
          where: { id: { in: ids } },
          data: { paymentReference: reference },
        });
        await prisma.paymentAttempt.create({
          data: {
            buyerId,
            provider: 'PAYSTACK',
            providerMode: 'TEST',
            paymentMethod: 'PAYSTACK',
            status: 'PAID',
            reference,
            amount: 1300,
            currency: 'NGN',
            settlementCurrency: 'NGN',
            settlementAmount: 1300,
            orderIds: ids,
          },
        });
      }
      const sync = new StandardOrderFinanceSyncService(
        prisma,
        escrow,
        new FinancialDocumentsService(prisma),
      );
      queries.length = 0;
      await sync.syncPaidOrdersByOrderIds(paidOrders.map((row) => row.id));
      const syncSelects = queries.filter((query) =>
        /^\s*SELECT\b/i.test(query),
      );
      evidence.financeSyncOrderScansFor26 = syncSelects.filter((query) =>
        /FROM "public"\."Order"/.test(query),
      ).length;
      evidence.financeSyncPaymentScansFor26 = syncSelects.filter((query) =>
        /FROM "public"\."PaymentAttempt"/.test(query),
      ).length;
      evidence.financeSyncSnapshotReplayReadsForTwoPayments =
        syncSelects.filter((query) =>
          /FROM "public"\."settlement_snapshot"/.test(query),
        ).length;
      assert.equal(evidence.financeSyncOrderScansFor26, 1);
      assert.equal(evidence.financeSyncPaymentScansFor26, 1);
      assert.equal(evidence.financeSyncSnapshotReplayReadsForTwoPayments, 2);
      assert.equal(
        await prisma.financialDocument.count({
          where: { type: 'BUYER_RECEIPT' },
        }),
        2,
      );
      assert.equal(
        await prisma.ledgerTransaction.count({
          where: { referenceId: { in: paidOrders.map((row) => row.id) } },
        }),
        78,
      );
      await sync.syncPaidOrdersByReferences(receiptReferences);
      assert.equal(
        await prisma.financialDocument.count({
          where: { type: 'BUYER_RECEIPT' },
        }),
        2,
      );
      evidence.cases.push(
        'finance sync loads26 orders and two paid attempts in shared scans, retains two payment transactions/two receipts, uses one snapshot replay read per payment and repeats without duplicate documents or money',
      );
      const nextOrders = Array.from({ length: 2 }, () => ({
        ...paidOrders[0],
        id: randomUUID(),
      }));
      await prisma.order.createMany({ data: nextOrders });
      const calculations = await calculator.calculateBatch(
        nextOrders.map((order) => ({
          orderType: 'STANDARD_ORDER',
          orderId: order.id,
          brandId,
          grossAmount: 100,
          currency: 'NGN',
          effectiveAt: new Date(),
        })),
      );
      const snapshotHeld = deferred(),
        snapshotRelease = deferred();
      const snapshotWinner = prisma.$transaction(
        async (tx) => {
          const value = await snapshots.createFromCalculation(
            calculations[0],
            tx,
          );
          snapshotHeld.resolve();
          await snapshotRelease.promise;
          return value;
        },
        { timeout: 20000 },
      );
      await snapshotHeld.promise;
      const snapshotLoser = prisma.$transaction(
        async (tx) => {
          const value = await snapshots.createFromCalculation(
            { ...calculations[0], commissionRate: 77 },
            tx,
          );
          await tx.$queryRaw`SELECT 1`;
          return value;
        },
        { timeout: 20000 },
      );
      try {
        await waitForBlocked();
      } finally {
        snapshotRelease.resolve();
      }
      const snapshotResults = await Promise.all([
        snapshotWinner,
        snapshotLoser,
      ]);
      assert.equal(snapshotResults[0].id, snapshotResults[1].id);
      assert.equal(snapshotResults[1].commissionRate.toFixed(2), '50.00');
      assert.equal(
        await prisma.settlementSnapshot.count({
          where: { orderId: nextOrders[0].id },
        }),
        1,
      );
      evidence.cases.push(
        'actual competing snapshot inserts wait and replay the immutable winner; losing PostgreSQL transaction remains usable after the conflict',
      );
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await snapshots.createFromCalculation(calculations[1], tx);
          throw Error('Snapshot rollback fixture');
        }),
        /Snapshot rollback fixture/,
      );
      assert.equal(
        await prisma.settlementSnapshot.count({
          where: { orderId: nextOrders[1].id },
        }),
        0,
      );
      evidence.cases.push(
        'snapshot INSERT participates in the enclosing transaction rollback',
      );
      const maintenanceOrders = Array.from({ length: 101 }, () => ({
        ...paidOrders[0],
        id: randomUUID(),
      }));
      await prisma.order.createMany({ data: maintenanceOrders });
      const maintenanceRows = maintenanceOrders.map((order) => ({
        orderId: order.id,
        snapshotData: snapshots.toSnapshotData({
          ...calculations[0],
          orderId: order.id,
        }),
      }));
      const maintenance = new SettlementBackfillService(prisma, config);
      const records = [
        {
          orderId: nextOrders[0].id,
          snapshotData: snapshots.toSnapshotData(calculations[0]),
        },
        ...maintenanceRows,
      ];
      queries.length = 0;
      assert.deepEqual(await maintenance.writeSnapshots(records, 'orderId'), {
        created: 101,
        skippedExisting: 1,
      });
      evidence.maintenanceSnapshotSelectsFor102 = queries.filter((query) =>
        /^\s*SELECT\b/i.test(query),
      ).length;
      evidence.maintenanceSnapshotInsertsFor102 = queries.filter((query) =>
        /INSERT INTO "public"\."settlement_snapshot"/.test(query),
      ).length;
      assert.equal(evidence.maintenanceSnapshotSelectsFor102, 0);
      assert.equal(evidence.maintenanceSnapshotInsertsFor102, 2);
      assert.deepEqual(await maintenance.writeSnapshots(records, 'orderId'), {
        created: 0,
        skippedExisting: 102,
      });
      evidence.cases.push(
        'operator snapshot writer inserts102 eligible records in two bounded commands with zero SELECTs, preserves an existing immutable snapshot, reports101 creations/one skip and replays without mutation',
      );
      const customIds = Array.from({ length: 26 }, () => randomUUID());
      queries.length = 0;
      for (const customOrderId of customIds)
        await prisma.$transaction((tx) =>
          ledger.postCustomOrderFinalRelease(tx, {
            customOrderId,
            brandId,
            currency: 'NGN',
            amount: 10,
            commissionAmount: 1,
            netBrandAmount: 9,
          }),
        );
      const customQueries = queries.slice();
      assert.equal(
        customQueries.filter(
          (query) =>
            /^\s*SELECT\b/i.test(query) &&
            /FROM "public"\."(?:User|Brand)"/.test(query),
        ).length,
        0,
      );
      assert.equal(
        await prisma.ledgerTransaction.count({
          where: { referenceId: { in: customIds } },
        }),
        26,
      );
      for (const customOrderId of customIds)
        await prisma.$transaction((tx) =>
          ledger.postCustomOrderFinalRelease(tx, {
            customOrderId,
            brandId,
            currency: 'NGN',
            amount: 10,
            commissionAmount: 1,
            netBrandAmount: 9,
          }),
        );
      assert.equal(
        await prisma.ledgerTransaction.count({
          where: { referenceId: { in: customIds } },
        }),
        26,
      );
      evidence.cases.push(
        '26 custom final-release ledger commands use current bulk account guards without brand/user metadata lookups and replay without duplicate money; order completion/queue eligibility remain separate checks',
      );
      await prisma.settlementPolicy.update({ where: { id: policy.id }, data: { releaseMode: 'HOLD_UNTIL_DELIVERY', upfrontReleaseEnabled: false, upfrontReleasePercent: 0 } });
      const refundFixtureOrders = Array.from({ length: 26 }, () => ({ id: randomUUID(), brandId, buyerId, customerName: 'SLA refund query fixture', items: [], totalAmount: new Prisma.Decimal(100), currency: 'NGN', status: 'PENDING', paymentStatus: 'PAID', paidAt: new Date(Date.now() - 4 * 3600000), paymentReference: `sla-refund-${randomUUID()}` }));
      await prisma.order.createMany({ data: refundFixtureOrders });
      await prisma.paymentAttempt.createMany({ data: refundFixtureOrders.map(order => ({ buyerId, provider: 'PAYSTACK', providerMode: 'test', paymentMethod: 'PAYSTACK', status: 'PAID', reference: order.paymentReference, amount: 100, currency: 'NGN', orderIds: [order.id], subjectType: 'STANDARD_ORDER' })) });
      await prisma.$transaction(tx => escrow.ensureHoldsForPaidOrders(tx, refundFixtureOrders, 2600, 'NGN'), { timeout: 30000 });
      const refundService = new OrderRefundService(prisma, escrow);
      const slaEvents = [], slaRealtime = [];
      const sla = new OrderSlaCronService(prisma, {
        createEvents: async events => { slaEvents.push(...events); return events.map(() => ({ status: 'fulfilled' })); },
        emitOrderUpdated: async (...args) => { slaRealtime.push(args); },
      }, refundService);
      const slaConfig = Object.fromEntries(['ORDER_SLA_ENABLED','ORDER_SLA_AUTO_CANCEL_ENABLED','ORDER_SLA_HARD_CLOSE_HOURS'].map(key => [key,process.env[key]]));
      process.env.ORDER_SLA_ENABLED = 'true'; process.env.ORDER_SLA_AUTO_CANCEL_ENABLED = 'true'; process.env.ORDER_SLA_HARD_CLOSE_HOURS = '1';
      try {
        queries.length = 0;
        await sla.escalateOrCloseOverdue();
        evidence.standardRefundContextJoinsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "Order" o/.test(query) && /LEFT JOIN LATERAL/.test(query)).length;
        assert.equal(evidence.standardRefundContextJoinsFor26, 26);
        const refundIds = refundFixtureOrders.map(row => row.id);
        assert.equal(await prisma.order.count({ where: { id: { in: refundIds }, status: 'CANCELLED', paymentStatus: 'REFUNDED' } }), 26);
        assert.equal(await prisma.escrowHold.count({ where: { orderId: { in: refundIds }, status: 'REFUNDED' } }), 26);
        assert.equal(await prisma.ledgerTransaction.count({ where: { referenceId: { in: refundIds }, type: 'REFUND_ISSUED' } }), 26);
        assert.equal(slaEvents.filter(event => refundIds.includes(event.opts.payload.orderId)).length, 52);
        assert.equal(slaRealtime.length, 26);
        await sla.escalateOrCloseOverdue();
        assert.equal(slaRealtime.length, 26);
        assert.equal(await prisma.ledgerTransaction.count({ where: { referenceId: { in: refundIds }, type: 'REFUND_ISSUED' } }), 26);
        const replay = await prisma.$transaction(tx => refundService.initiateRefund(tx, { orderId: refundIds[0], reason: 'Replay' }));
        assert.equal(replay.alreadyRefunded, true);
      } finally {
        for (const [key,value] of Object.entries(slaConfig)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
      }
      evidence.cases.push('actual SLA cron refunds26 independent test-mode captures using26 current order/capture JOINs,26 real escrow/journal transitions and52 recipient-event handoffs; repeat and direct replay add no refund money; provider transport is outside this query proof');
      assert.equal(await loadStandardOrderRefundContext(prisma, randomUUID()), null);
      const unlinkedOrder = await prisma.order.create({ data: { id: randomUUID(), brandId, buyerId, customerName: 'Fallback query fixture', items: [], totalAmount: 1, paymentStatus: 'PAID', paymentReference: '' } });
      assert.equal((await loadStandardOrderRefundContext(prisma, unlinkedOrder.id)).attempt, null);
      const fallbackAttempts = await Promise.all([0,1].map(index => prisma.paymentAttempt.create({ data: { buyerId, provider: 'PAYSTACK', providerMode: 'test', paymentMethod: 'PAYSTACK', status: 'PAID', reference: `fallback-${randomUUID()}`, amount: new Prisma.Decimal(index ? '12345678.91' : '1.00'), currency: 'NGN', orderIds: [unlinkedOrder.id], createdAt: new Date(Date.now() + index * 1000) } })));
      const fallbackContext = await loadStandardOrderRefundContext(prisma, unlinkedOrder.id);
      assert.equal(fallbackContext.attempt.id, fallbackAttempts[1].id);
      assert.equal(fallbackContext.attempt.amount.toFixed(2), '12345678.91');
      evidence.cases.push('standard refund context distinguishes missing order from missing capture, preserves current empty-reference/latest-array fallback and native Decimal precision; old-data fallback retirement remains a separate gate');
      {
      const staleReferences = Array.from({ length: 26 }, () => `stale-fixture-${randomUUID()}`);
      const staleOrders = staleReferences.map(reference => ({ id: randomUUID(), buyerId, brandId, customerName: 'Stale payment fixture', items: [], totalAmount: 100, currency: 'NGN', paymentStatus: 'PENDING', paymentReference: reference }));
      await prisma.order.createMany({ data: staleOrders });
      await prisma.paymentAttempt.createMany({ data: staleReferences.map((reference,index) => ({ buyerId, subjectType: 'STANDARD_ORDER', provider: 'PAYSTACK', providerMode: 'live', paymentMethod: 'PAYSTACK', reference, status: 'PENDING', amount: 100, currency: 'NGN', orderIds: [staleOrders[index].id], expiresAt: new Date(Date.now() - 3600000), updatedAt: new Date(Date.now() - 7200000) })) });
      const payments = new PaymentService(prisma, new FxRateService(prisma), sync, {}, {}, {});
      queries.length = 0;
      const staleResult = await payments.reconcileStalePaymentAttempts({ olderThanMinutes: 30, limit: 26 }, ownerId);
      evidence.stalePaymentLockedReadsFor26 = queries.filter(query => /^\s*SELECT \* FROM "PaymentAttempt"/.test(query) && /FOR UPDATE/.test(query)).length;
      evidence.stalePaymentPrismaScansFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."PaymentAttempt"/.test(query)).length;
      assert.equal(staleResult.scanned, 26); assert.equal(staleResult.updated, 26); assert.equal(staleResult.failed.length, 0);
      assert.equal(evidence.stalePaymentLockedReadsFor26, 26);
      assert.equal(evidence.stalePaymentPrismaScansFor26, 1);
      const staleAttempts = await prisma.paymentAttempt.findMany({ where: { reference: { in: staleReferences } } });
      assert(staleAttempts.every(row => row.status === 'EXPIRED' && row.finalizedAt && row.settlementCurrency === 'NGN' && row.settlementAmount.toFixed(2) === '100.00'));
      assert.equal(await prisma.order.count({ where: { id: { in: staleOrders.map(row => row.id) }, paymentStatus: 'FAILED' } }), 26);
      assert.equal(await prisma.paymentEvent.count({ where: { paymentAttemptId: { in: staleAttempts.map(row => row.id) }, type: 'STATUS_EXPIRED' } }), 26);
      assert.equal((await payments.reconcileStalePaymentAttempts({ olderThanMinutes: 30, limit: 26 }, ownerId)).scanned, 0);
      await Promise.all([payments.applyAttemptStatus(staleReferences[0], '', 'PAID', 'reconcile'), payments.applyAttemptStatus(staleReferences[0], '', 'FAILED', 'reconcile')]);
      assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference: staleReferences[0] } })).status, 'EXPIRED');
      await assert.rejects(payments.applyAttemptStatus(staleReferences[0], ownerId, 'PAID', 'verify'), /not found/);
      evidence.cases.push('real stale-payment reconciliation26 expirations uses one shared scan plus26 atomic locked current-row reads and zero separate per-attempt reloads, retains NGN settlement/order/event transitions and terminal/ownership guards on concurrent replay without provider transport');

      const webhookKeys = staleAttempts.map(() => `fixture-webhook-${randomUUID()}`);
      await prisma.paymentEvent.createMany({ data: staleAttempts.map((attempt,index) => ({ paymentAttemptId: attempt.id, type: 'WEBHOOK_RECEIVED', source: 'query-fixture', providerEventKey: webhookKeys[index], providerEventReceivedAt: new Date(), payload: { event: 'charge.failed', data: { reference: attempt.reference } } })) });
      const reprocessed = await payments.reprocessPendingWebhookReceipts(26);
      assert.deepEqual(reprocessed, { scanned: 26, processed: 26, skipped: 0, failed: 0 });
      assert.equal(await prisma.paymentEvent.count({ where: { providerEventKey: { in: webhookKeys }, processedAt: { not: null } } }), 26);
      assert.deepEqual(await payments.reprocessPendingWebhookReceipts(26), { scanned: 0, processed: 0, skipped: 0, failed: 0 });
      assert.equal(await prisma.paymentEvent.count({ where: { paymentAttemptId: { in: staleAttempts.map(row => row.id) }, type: 'STATUS_EXPIRED' } }), 26);
      evidence.cases.push('real stored-webhook replay shares its receipt/attempt identity scans, checks each current terminal payment before marking its own receipt processed, handles26 then zero on replay, and makes no duplicate lifecycle transitions; incoming signature/provider delivery remain separate');

      const paymentLockReady = deferred(), paymentLockRelease = deferred();
      const lockWinner = prisma.$transaction(async tx => {
        const row = await lockPaymentAttempt(tx, staleReferences[0]);
        assert.equal(row.status, 'EXPIRED');
        paymentLockReady.resolve(); await paymentLockRelease.promise;
        await tx.paymentAttempt.update({ where: { id: row.id }, data: { providerChannel: 'fixture-committed' } });
      }, { timeout: 15000 });
      await paymentLockReady.promise;
      const lockLoser = prisma.$transaction(tx => lockPaymentAttempt(tx, staleReferences[0]), { timeout: 15000 });
      await waitForBlocked(); paymentLockRelease.resolve();
      const [, currentAfterWait] = await Promise.all([lockWinner,lockLoser]);
      assert.equal(currentAfterWait.providerChannel, 'fixture-committed');
      assert.equal(await prisma.$transaction(tx => lockPaymentAttempt(tx, `missing-${randomUUID()}`)), null);
      const nativePayment = await prisma.$transaction(tx => lockPaymentAttempt(tx, fallbackAttempts[1].reference));
      assert.equal(nativePayment.amount.toFixed(2), '12345678.91');
      evidence.cases.push('atomic PaymentAttempt SELECT FOR UPDATE waits for a competing writer and returns its committed current fields, preserves native Decimal and missing-reference behavior without a second query');
      if (process.env.STANDARD_PAYMENT_PROVIDER_SIM_URL) {
        const proof = await require('./standard-payment-provider-scenarios.cjs')({ prisma, queries, simulationUrl: process.env.STANDARD_PAYMENT_PROVIDER_SIM_URL, sync, ownerId, buyerId, brandId });
        evidence.cases.push(...proof.cases);
        evidence.standardPaymentProvider = { ...proof, cases: undefined };
      }
      }
    }
    {
      const billingOwnerId = randomUUID(),
        billingBrandId = randomUUID();
      await prisma.user.create({
        data: {
          id: billingOwnerId,
          username: billingOwnerId,
          email: `${billingOwnerId}@example.invalid`,
        },
      });
      await prisma.brand.create({
        data: {
          id: billingBrandId,
          ownerId: billingOwnerId,
          name: 'Compensation fixture',
        },
      });
      await prisma.subscriptionTier.upsert({
        where: { key: 'THREAD' },
        create: { key: 'THREAD', name: 'Thread', monthlyPriceNgn: 10000 },
        update: {},
      });
      const periodStart = new Date(),
        periodEnd = new Date(Date.now() + 30 * 86400000);
      const agreement = await prisma.brandSubscription.create({
        data: {
          brandId: billingBrandId,
          tierKey: 'THREAD',
          priceSnapshotNgn: 10000,
          status: 'ACTIVE',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });
      const invoice = await prisma.brandSubscriptionInvoice.create({
        data: {
          subscriptionId: agreement.id,
          reference: `invoice-fixture-${randomUUID()}`,
          amount: 10000,
          currency: 'NGN',
          periodStart,
          periodEnd,
        },
      });
      await prisma.brandSubscriptionPaymentCapture.createMany({
        data: Array.from({ length: 26 }, () => ({
          invoiceId: invoice.id,
          reference: `capture-fixture-${randomUUID()}`,
          amount: 10000,
          currency: 'NGN',
          paidAt: new Date(),
          status: 'REFUND_SUBMITTING',
          lockedAt: new Date(Date.now() - 11 * 60000),
          nextAttemptAt: new Date(0),
        })),
      });
      let providerCalls = 0;
      const billing = new SubscriptionsService(
        prisma,
        {},
        {},
        {
          refund: async () => {
            providerCalls++;
            throw Error('Interrupted submissions must not be resubmitted');
          },
          verifyRefund: async () => {
            providerCalls++;
            throw Error('No provider refund ID to poll');
          },
        },
      );
      queries.length = 0;
      for (let round = 0; round < 3; round++)
        await billing.processCompensations(new Date());
      const contextReads = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /JOIN "BrandSubscriptionInvoice"/.test(query) &&
          /JOIN "BrandSubscription"/.test(query),
      );
      evidence.compensationJoinedContextReadsFor26 = contextReads.length;
      evidence.compensationRelatedHydrationReadsFor26 = queries.filter(
        (query) =>
          /^\s*SELECT\b/i.test(query) &&
          /FROM "public"\."(?:BrandSubscriptionInvoice|BrandSubscription)"/.test(
            query,
          ),
      ).length;
      assert.equal(evidence.compensationJoinedContextReadsFor26, 52);
      assert.equal(evidence.compensationRelatedHydrationReadsFor26, 0);
      assert.equal(
        await prisma.brandSubscriptionPaymentCapture.count({
          where: { invoiceId: invoice.id, status: 'NEEDS_ATTENTION' },
        }),
        26,
      );
      assert.equal(
        await prisma.notification.count({
          where: { recipientId: billingOwnerId, type: 'ADMIN_ACTION' },
        }),
        26,
      );
      assert.equal(
        await prisma.emailOutbox.count({
          where: { recipientUserId: billingOwnerId },
        }),
        26,
      );
      assert.equal(
        await prisma.operationalAlert.count({
          where: { event: 'SUBSCRIPTION_COMPENSATION_REQUIRED' },
        }),
        26,
      );
      assert.equal(providerCalls, 0);
      assert.equal(
        (
          await prisma.brandSubscription.findUniqueOrThrow({
            where: { id: agreement.id },
          })
        ).currentPeriodEnd.getTime(),
        periodEnd.getTime(),
      );
      assert.equal(
        (
          await prisma.brandSubscription.findUniqueOrThrow({
            where: { id: agreement.id },
          })
        ).status,
        'ACTIVE',
      );
      await billing.processCompensations(new Date());
      assert.equal(
        await prisma.emailOutbox.count({
          where: { recipientUserId: billingOwnerId },
        }),
        26,
      );
      evidence.cases.push(
        '26 interrupted subscription refunds use fresh scalar capture/invoice/agreement JOINs after claim and inside attention, zero relation hydration reads, atomic inbox/email receipts, no provider resubmission and no entitlement change',
      );
      const precise = await prisma.brandSubscriptionPaymentCapture.create({
        data: {
          invoiceId: invoice.id,
          reference: `precision-fixture-${randomUUID()}`,
          amount: new Prisma.Decimal('1234567890.12'),
          currency: 'NGN',
          paidAt: new Date(),
          status: 'APPLIED',
        },
      });
      const preciseContext = await billing.loadCompensationCapture(
        prisma,
        precise.id,
      );
      assert.equal(preciseContext.amount.toFixed(2), '1234567890.12');
      assert.equal(preciseContext.invoice.amount.toFixed(2), '10000.00');
      assert.equal(preciseContext.invoice.subscription.brandId, billingBrandId);
      evidence.cases.push(
        'flat subscription compensation JOIN retains native Decimal precision and current invoice/brand identity without loading authorization data',
      );
      let billingProviderCalls = 0;
      const receiptBilling = new SubscriptionsService(prisma, new BrandAccessService(prisma), {}, {
        verify: async () => { billingProviderCalls++; throw Error('Recorded paid receipts must not call provider verification'); },
        charge: async () => { billingProviderCalls++; throw Error('No provider debit allowed in query regression'); },
      });
      const receiptReferences = [invoice.reference, ...Array.from({ length: 4 }, (_, index) => `${invoice.reference}-a${index + 1}`), ...Array.from({ length: 20 }, () => `${invoice.reference}-h${randomUUID()}`)];
      await prisma.brandSubscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', attemptCount: 4, hostedAttemptReferences: receiptReferences.slice(5) } });
      await prisma.brandSubscriptionPaymentCapture.createMany({ data: receiptReferences.map(reference => ({ invoiceId: invoice.id, reference, amount: 10000, currency: 'NGN', paidAt: new Date(), status: 'APPLIED' })) });
      queries.length = 0;
      const ownerVerification = await receiptBilling.verifyForOwner(billingOwnerId, billingBrandId, invoice.reference);
      evidence.paidInvoiceCaptureReadsFor25References = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."BrandSubscriptionPaymentCapture"/.test(query) && !/"status" <>/.test(query)).length;
      // Owner summary has its own shared compensation projection; verification is identified by its two-column SELECT.
      evidence.paidInvoiceReceiptBatchReads = queries.filter(query => {
        const projection = query.split(/\sFROM\s/)[0];
        return /^\s*SELECT\b/i.test(query) && /FROM "public"\."BrandSubscriptionPaymentCapture"/.test(query) && projection.includes('"reference"') && projection.includes('"status"') && !projection.includes('"amount"');
      }).length;
      assert.equal(evidence.paidInvoiceReceiptBatchReads, 1);
      assert.equal(ownerVerification.status, 'PAID');
      assert.equal(ownerVerification.paid, true);
      assert.equal(billingProviderCalls, 0);
      const beforePaidPeriod = await prisma.brandSubscription.findUniqueOrThrow({ where: { id: agreement.id } });
      await assert.rejects(receiptBilling.prepareHostedPayment(invoice.id, 'changed@example.invalid'), /already been received/);
      await assert.rejects(receiptBilling.verifyForOwner(randomUUID(), billingBrandId, invoice.reference), /owner|permission|brand/i);
      const afterPaidPeriod = await prisma.brandSubscription.findUniqueOrThrow({ where: { id: agreement.id } });
      assert.equal(+afterPaidPeriod.currentPeriodEnd, +beforePaidPeriod.currentPeriodEnd);
      assert.equal(afterPaidPeriod.status, beforePaidPeriod.status);
      assert.equal(billingProviderCalls, 0);
      evidence.cases.push('paid invoice owner verification batches25 named capture receipts in one SELECT, retains real ownership authorization and current summary, refuses another hosted charge and does not call provider or extend entitlement');

      await prisma.subscriptionTier.upsert({ where: { key: 'ARU' }, create: { key: 'ARU', name: 'Aru', monthlyPriceNgn: 30000 }, update: { monthlyPriceNgn: 30000 } });
      const renewalNow = new Date();
      const renewalAgreements = [];
      for (let index = 0; index < 26; index++) {
        const renewalOwner = await prisma.user.create({ data: { id: randomUUID(), username: `renewal-${randomUUID()}`, email: `${randomUUID()}@example.invalid` } });
        const renewalBrand = await prisma.brand.create({ data: { id: randomUUID(), ownerId: renewalOwner.id, name: 'Renewal query fixture' } });
        const renewalAgreement = await prisma.brandSubscription.create({ data: { brandId: renewalBrand.id, tierKey: 'THREAD', status: 'ACTIVE', priceSnapshotNgn: 10000, currentPeriodStart: new Date(+renewalNow - 31 * 86400000), currentPeriodEnd: new Date(+renewalNow - 86400000), scheduledTierKey: index % 2 ? 'ARU' : null, providerCustomerEmail: renewalOwner.email } });
        renewalAgreements.push({ ...renewalAgreement, fixtureOwnerId: renewalOwner.id });
      }
      queries.length = 0;
      for (const row of renewalAgreements) await receiptBilling.prepareRenewal(row.id, row.brandId, renewalNow);
      evidence.renewalContextJoinsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "BrandSubscription" s/.test(query) && /JOIN "SubscriptionTier"/.test(query)).length;
      evidence.renewalTierReloadsFor26 = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."SubscriptionTier"/.test(query)).length;
      assert.equal(evidence.renewalContextJoinsFor26, 26);
      assert.equal(evidence.renewalTierReloadsFor26, 0);
      const renewalBrandIds = renewalAgreements.map(row => row.brandId);
      const renewalInvoices = await prisma.brandSubscriptionInvoice.findMany({ where: { purpose: 'RENEWAL', subscription: { brandId: { in: renewalBrandIds } } }, include: { subscription: true } });
      assert.equal(renewalInvoices.length, 26);
      assert.equal(renewalInvoices.filter(row => row.amount.toFixed(2) === '10000.00').length, 13);
      assert.equal(renewalInvoices.filter(row => row.amount.toFixed(2) === '30000.00').length, 13);
      assert(renewalInvoices.every(row => row.subscription.tierKey === (row.amount.toFixed(2) === '30000.00' ? 'ARU' : 'THREAD')));
      await prisma.subscriptionTier.update({ where: { key: 'ARU' }, data: { monthlyPriceNgn: 50000 } });
      for (const row of renewalAgreements) await receiptBilling.prepareRenewal(row.id, row.brandId, renewalNow);
      const replayInvoices = await prisma.brandSubscriptionInvoice.findMany({ where: { purpose: 'RENEWAL', subscription: { brandId: { in: renewalBrandIds } } } });
      assert.equal(replayInvoices.length, 26);
      assert.equal(replayInvoices.filter(row => row.amount.toFixed(2) === '30000.00').length, 13);
      assert.equal(await prisma.notification.count({ where: { recipientId: { in: renewalAgreements.map(row => row.fixtureOwnerId) } } }), 26);
      assert.equal(await prisma.emailOutbox.count({ where: { recipientUserId: { in: renewalAgreements.map(row => row.fixtureOwnerId) } } }), 26);
      assert.equal(billingProviderCalls, 0);
      evidence.cases.push('26 actual renewal commands read26 current agreement/scheduled-tier JOINs with zero tier reloads, create13 original-price and13 scheduled-tier invoices, retain unique periods/prices on replay after catalog price changes and perform no provider debit');
    }
    const { PrismaService } = require('../src/prisma/prisma.service');
    const runtimeUrl = new URL(testUrl);
    runtimeUrl.searchParams.set(
      'application_name',
      'wiez_runtime_pool_lifecycle',
    );
    const previousUrl = process.env.DATABASE_URL;
    let runtime;
    try {
      process.env.DATABASE_URL = runtimeUrl.toString();
      runtime = new PrismaService();
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
    try {
      await runtime.onModuleInit();
    } finally {
      await runtime.onModuleDestroy();
    }
    const remaining = await admin.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND application_name='wiez_runtime_pool_lifecycle'`,
      [database],
    );
    assert.equal(
      remaining.rows[0].count,
      0,
      'Application shutdown must dispose its database pool',
    );
    evidence.cases.push(
      'actual PrismaService initializes UTC and closes owned connections on module shutdown',
    );
    evidence.passed = true;
  } finally {
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_ledger_race_[a-f0-9]{32}$/.test(database));
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
        '../docs/performance-reviews/ledger-concurrency-postgres-2026-10-23.json',
      ),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error) => {
  console.error(
    error instanceof assert.AssertionError ||
      error instanceof TypeError ||
      error.code === 'P2010'
      ? error.message
      : error.code || error.name || 'Ledger fixture failed',
  );
  process.exitCode = 1;
});
