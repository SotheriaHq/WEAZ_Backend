// Canonical standard-order refunds, brand debt, ledger/tag/membership guards and
// product removal, with the actual services, in a disposable PostgreSQL database
// and against a loopback Paystack-shaped simulator. Only synthetic keys, money and
// users are used; no real provider is ever contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
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
const { SettlementSnapshotService } = require('../src/finance/settlement-snapshot.service');
const { SettlementCalculatorService } = require('../src/finance/settlement-calculator.service');
const { SettlementPolicyService } = require('../src/finance/settlement-policy.service');
const { CommissionService } = require('../src/finance/commission.service');
const { StandardOrderEscrowService } = require('../src/finance/standard-order-escrow.service');
const { StandardOrderFinanceSyncService } = require('../src/finance/standard-order-finance-sync.service');
const { FinancialDocumentsService } = require('../src/finance/financial-documents.service');
const { BrandBalanceService } = require('../src/finance/brand-balance.service');
const { loadBrandPosition } = require('../src/finance/brand-position-query');
const { RefundProviderClient } = require('../src/finance/refund-provider.client');
const { StandardOrderRefundsService } = require('../src/finance/standard-order-refunds.service');
const { AdminOrderController } = require('../src/order/admin-order.controller');
const { StoreService } = require('../src/store/store.service');
const { lockCheckoutProducts, isSellableAfterLock } = require('../src/payment/checkout-inventory-query');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A loopback stand-in for the Paystack refund API, in its documented shapes. */
function paystackSimulator() {
  const state = {
    transactions: new Map(),
    refunds: new Map(),
    posts: new Map(),
    modes: new Map(),
    listDown: false,
    gates: new Map(),
    sequence: 7000,
    unauthorized: 0,
  };
  // Create returns the transaction object; fetch and list return its numeric id.
  const view = (refund, expanded) => ({
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    merchant_note: refund.note,
    domain: 'test',
    transaction: expanded
      ? { id: refund.transactionId, reference: refund.reference }
      : refund.transactionId,
  });
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!/^Bearer sk_test_/.test(req.headers.authorization ?? '')) {
        state.unauthorized++;
        return send(401, { status: false, message: 'Invalid key' });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname.startsWith('/transaction/verify/')) {
        const reference = decodeURIComponent(url.pathname.slice('/transaction/verify/'.length));
        const transaction = state.transactions.get(reference);
        if (!transaction) return send(404, { status: false, message: 'Transaction reference not found' });
        return send(200, {
          status: true,
          data: { id: transaction.id, reference, status: 'success', amount: transaction.amount, currency: transaction.currency },
        });
      }
      if (req.method === 'POST' && url.pathname === '/refund') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        state.posts.set(body.transaction, (state.posts.get(body.transaction) ?? 0) + 1);
        const transaction = state.transactions.get(body.transaction);
        const mode = state.modes.get(body.transaction) ?? 'accept';
        if (!transaction) return send(404, { status: false, message: 'Transaction not found' });
        if (mode === 'reject400' || body.amount > transaction.amount)
          return send(400, { status: false, message: 'Refund amount cannot be processed' });
        const refund = {
          id: ++state.sequence,
          reference: body.transaction,
          transactionId: transaction.id,
          amount: body.amount,
          currency: body.currency,
          note: body.merchant_note,
          status: 'pending',
          createdAt: Date.now(),
        };
        state.refunds.set(String(refund.id), refund);
        if (mode === 'drop-buried') {
          // Other merchants' refunds made since push this one past the first page.
          for (let index = 0; index < 150; index++) {
            const id = ++state.sequence;
            state.refunds.set(String(id), {
              id, reference: `noise-${id}`, transactionId: id, amount: 100, currency: 'NGN',
              note: 'another refund', status: 'pending', createdAt: Date.now(),
            });
          }
        }
        if (mode === 'drop' || mode === 'drop-buried') {
          // The refund exists at the provider, but the answer never arrives.
          req.socket.destroy();
          return;
        }
        if (mode === 'slow') {
          const gate = state.gates.get(body.transaction);
          gate.arrived.resolve(refund);
          await gate.release.promise;
        }
        return send(200, { status: true, message: 'Refund has been queued for processing', data: view(refund, true) });
      }
      if (req.method === 'GET' && url.pathname === '/refund') {
        // Documented List Refunds: page, perPage, from, to. There is no
        // transaction filter, so anything else in the query is ignored.
        if (state.listDown) return send(503, { status: false });
        const perPage = Math.min(Number(url.searchParams.get('perPage') ?? 50), 100);
        const page = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
        const from = url.searchParams.get('from') ? Date.parse(url.searchParams.get('from')) : null;
        const rows = [...state.refunds.values()]
          .filter((refund) => from === null || (refund.createdAt ?? Date.now()) >= from)
          .sort((a, b) => b.id - a.id)
          .slice((page - 1) * perPage, page * perPage);
        return send(200, { status: true, data: rows.map((refund) => view(refund, false)) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/refund/')) {
        const refund = state.refunds.get(decodeURIComponent(url.pathname.slice('/refund/'.length)));
        if (!refund) return send(404, { status: false, message: 'Refund not found' });
        return send(200, { status: true, data: view(refund, false) });
      }
      return send(404, { status: false });
    } catch {
      if (!res.headersSent) send(500, { status: false });
    }
  });
  return { server, state };
}

const failureText = (error) =>
  [error?.message, error?.code, JSON.stringify(error?.meta ?? {}), String(error?.cause ?? ''), JSON.stringify(error?.response ?? {})].join(' ');
const rejectsWith = (promise, pattern) =>
  assert.rejects(promise, (error) => {
    assert.match(failureText(error), pattern);
    return true;
  });

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const database = `wiez_refund_integrity_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  const savedEnv = Object.fromEntries(
    ['PAYSTACK_SECRET_KEY', 'NODE_ENV', 'STANDARD_ORDER_REFUND_SIMULATION_ENABLED'].map((key) => [key, process.env[key]]),
  );
  // A synthetic test-mode key: the real one is never read into a request here.
  process.env.PAYSTACK_SECRET_KEY = `sk_test_fixture_${randomUUID().replaceAll('-', '')}`;
  delete process.env.STANDARD_ORDER_REFUND_SIMULATION_ENABLED;
  const simulator = paystackSimulator();
  let created = false,
    prisma;
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cleanupPassed: false, cases: [] };
  const waitForBlocked = async () => {
    for (let i = 0; i < 500; i++) {
      const result = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'`,
        [database],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error('Expected the competing transaction to wait for the row lock');
  };
  await admin.connect();
  try {
    await new Promise((resolve) => simulator.server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${simulator.server.address().port}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' },
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, 'Disposable migrations must succeed');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl.toString(), max: 12 }) });

    const config = {
      getNumber: async (key) => ({ 'finance.standardEscrow.settlementHours': 48, 'finance.standardEscrow.autoReleaseDays': 7 })[key] ?? 0,
    };
    const ledger = new LedgerService(prisma);
    const calculator = new SettlementCalculatorService(
      new SettlementPolicyService(prisma, config),
      new CommissionService(prisma, config),
    );
    const balance = new BrandBalanceService(prisma);
    const escrow = new StandardOrderEscrowService(prisma, config, ledger, calculator, new SettlementSnapshotService(prisma), balance);
    const sync = new StandardOrderFinanceSyncService(prisma, escrow, new FinancialDocumentsService(prisma));
    const provider = new RefundProviderClient({ PAYSTACK: baseUrl, FLUTTERWAVE: baseUrl });
    const buyerNotices = [];
    const refunds = new StandardOrderRefundsService(prisma, escrow, sync, provider, {
      create: async (recipientId, type, opts) => {
        buyerNotices.push({ recipientId, type, ...opts });
      },
    });

    const users = Array.from({ length: 5 }, () => randomUUID());
    await prisma.user.createMany({
      data: users.map((id) => ({ id, username: `refund-${id}`, email: `${id}@example.invalid` })),
    });
    const [buyer, owner1, owner2, owner3, adminId] = users;
    const [brand1, brand2, brand3] = [randomUUID(), randomUUID(), randomUUID()];
    await prisma.brand.createMany({
      data: [
        { id: brand1, ownerId: owner1, name: 'Refund fixture one' },
        { id: brand2, ownerId: owner2, name: 'Refund fixture two' },
        { id: brand3, ownerId: owner3, name: 'Refund fixture three' },
      ],
    });
    await prisma.settlementPolicy.create({
      data: {
        orderType: 'STANDARD_ORDER', scope: 'PLATFORM', currency: 'NGN', releaseMode: 'SPLIT_RELEASE',
        upfrontReleaseEnabled: true, upfrontReleasePercent: 30, isDefault: true, effectiveFrom: new Date('2000-01-01T00:00:00Z'),
      },
    });
    await prisma.commissionRule.create({
      data: { name: 'Refund fixture', scope: 'PLATFORM', currency: 'NGN', ratePercent: 10, isDefault: true, effectiveFrom: new Date('2000-01-01T00:00:00Z') },
    });

    let transactionSequence = 5000;
    const paid = async ({ brandId, amount = 100, status = 'PROCESSING', productId = null, mode = 'test' }) => {
      const id = randomUUID(),
        reference = `refund-fixture-${randomUUID()}`,
        providerTransactionId = String(++transactionSequence);
      const order = await prisma.order.create({
        data: {
          id, brandId, buyerId: buyer, customerName: 'Refund fixture', items: productId ? [{ productId }] : [],
          totalAmount: amount, currency: 'NGN', status, paymentStatus: 'PAID', paidAt: new Date(), paymentReference: reference,
        },
      });
      if (productId)
        await prisma.orderItem.create({ data: { orderId: id, productId, brandId, unitPrice: amount, totalPrice: amount } });
      const capture = await prisma.paymentAttempt.create({
        data: {
          buyerId: buyer, provider: 'PAYSTACK', providerMode: mode, paymentMethod: 'PAYSTACK', status: 'PAID', reference,
          providerTransactionId, amount, currency: 'NGN', settlementAmount: amount, settlementCurrency: 'NGN',
          orderIds: [id], subjectType: 'STANDARD_ORDER',
        },
      });
      simulator.state.transactions.set(reference, { id: Number(providerTransactionId), amount: Math.round(amount * 100), currency: 'NGN' });
      await prisma.$transaction((tx) => escrow.ensureHoldsForPaidOrders(tx, [order], amount, 'NGN'), { timeout: 20000 });
      return { order, capture, reference, hold: await prisma.escrowHold.findUniqueOrThrow({ where: { orderId: id } }) };
    };
    const request = (orderId, trigger = 'ADMIN') =>
      prisma.$transaction((tx) => refunds.requestInTransaction(tx, { orderId, trigger, reason: 'Fixture refund' }), {
        timeout: 20000,
        maxWait: 20000,
      });
    // Only the named refunds are due; everything else waits.
    const only = async (ids) => {
      await prisma.standardOrderRefund.updateMany({
        where: { id: { notIn: ids }, status: { in: ['REQUESTED', 'FAILED', 'PROCESSING'] } },
        data: { nextAttemptAt: new Date(Date.now() + 86400000) },
      });
      await prisma.standardOrderRefund.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    };
    const refundRow = (id) => prisma.standardOrderRefund.findUniqueOrThrow({ where: { id } });
    const posts = (reference) => simulator.state.posts.get(reference) ?? 0;
    const providerRefund = (id) => simulator.state.refunds.get(String(id));
    const settledJournals = (refundId) =>
      prisma.ledgerTransaction.count({ where: { referenceType: 'StandardOrderRefund', referenceId: refundId, type: 'REFUND_ISSUED' } });

    // ── Concurrent requests converge ───────────────────────────────────────
    const a1 = await paid({ brandId: brand1 });
    assert.equal(a1.hold.status, 'PARTIALLY_RELEASED');
    assert.equal(a1.hold.firstReleaseNetAmount.toFixed(2), '27.00');
    const competing = await Promise.all(
      ['RETURN', 'SLA_TIMEOUT', 'ADMIN_SLA_CANCEL', 'PRODUCT_REMOVAL', 'ADMIN', 'RETURN', 'ADMIN', 'SLA_TIMEOUT'].map((trigger) =>
        request(a1.order.id, trigger),
      ),
    );
    const refundA1 = competing[0].id;
    assert.equal(new Set(competing.map((row) => row.id)).size, 1);
    assert.equal(await prisma.standardOrderRefund.count({ where: { orderId: a1.order.id } }), 1);
    assert.equal((await prisma.escrowHold.findUniqueOrThrow({ where: { id: a1.hold.id } })).status, 'REFUND_PENDING');
    assert.equal(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:order:${a1.order.id}:refund_reserved` } }), 1);
    const clawbacksA1 = await prisma.brandBalanceAdjustment.findMany({ where: { orderId: a1.order.id } });
    assert.equal(clawbacksA1.length, 1);
    assert.equal(clawbacksA1[0].type, 'REFUND_CLAWBACK');
    assert.equal(clawbacksA1[0].amount.toFixed(2), '27.00');
    assert.equal(clawbacksA1[0].sourceKey, `standard-order-refund:${refundA1}`);
    assert.equal(await prisma.paymentEvent.count({ where: { type: 'STANDARD_ORDER_REFUND_REQUESTED', paymentAttemptId: a1.capture.id } }), 1);
    evidence.cases.push('eight concurrent refund requests for one paid order (return, SLA, admin, product removal) converge on one refund, one escrow reservation, one reserve journal and one clawback keyed to the refund');

    // ── Release vs refund, both orders ─────────────────────────────────────
    const a2 = await paid({ brandId: brand1 });
    const a2Journals = await prisma.ledgerTransaction.count({ where: { referenceId: a2.order.id } });
    const releaseHeld = deferred(),
      releaseGo = deferred();
    const releasing = prisma.$transaction(
      async (tx) => {
        const hold = await escrow.releaseFinalPortionNow(tx, a2.order.id);
        releaseHeld.resolve();
        await releaseGo.promise;
        return hold;
      },
      { timeout: 20000 },
    );
    await releaseHeld.promise;
    const refundingAfterRelease = request(a2.order.id, 'RETURN');
    try {
      await waitForBlocked();
    } finally {
      releaseGo.resolve();
    }
    const [releasedA2, requestA2] = await Promise.all([releasing, refundingAfterRelease]);
    assert(releasedA2.secondReleasedAt);
    assert.equal(requestA2.breakdownJson.releasedNet, '90.00');
    assert.equal((await prisma.brandBalanceAdjustment.findFirstOrThrow({ where: { orderId: a2.order.id } })).amount.toFixed(2), '90.00');
    assert.equal(await prisma.ledgerTransaction.count({ where: { referenceId: a2.order.id } }), a2Journals + 1);

    const a3 = await paid({ brandId: brand1 });
    const a3Journals = await prisma.ledgerTransaction.count({ where: { referenceId: a3.order.id } });
    const refundHeld = deferred(),
      refundGo = deferred();
    const refundingFirst = prisma.$transaction(
      async (tx) => {
        const row = await refunds.requestInTransaction(tx, { orderId: a3.order.id, trigger: 'ADMIN', reason: 'Fixture refund' });
        refundHeld.resolve();
        await refundGo.promise;
        return row;
      },
      { timeout: 20000 },
    );
    await refundHeld.promise;
    const releasingLate = prisma.$transaction((tx) => escrow.releaseFinalPortionNow(tx, a3.order.id), { timeout: 20000 });
    try {
      await waitForBlocked();
    } finally {
      refundGo.resolve();
    }
    const [requestA3, lateHold] = await Promise.all([refundingFirst, releasingLate]);
    assert.equal(lateHold.status, 'REFUND_PENDING');
    assert.equal(lateHold.secondReleasedAt, null);
    assert.equal(requestA3.breakdownJson.releasedNet, '27.00');
    assert.equal(await escrow.releaseEligibleFinalPortions(), 0);
    assert.equal(await prisma.ledgerTransaction.count({ where: { referenceId: a3.order.id } }), a3Journals);
    // Released but never withdrawn: the refund takes the money back and no debt remains.
    const position1 = await loadBrandPosition(prisma, brand1, 'NGN');
    assert.equal(position1.position.toFixed(2), '0.00');
    assert.equal((await balance.getDebtSnapshot(brand1)).outstanding, 0);
    assert.equal(await prisma.brandBalanceAdjustment.count({ where: { brandId: brand1, status: 'RECOVERED' } }), 3);
    evidence.cases.push('a final release committed first is clawed back in full by the waiting refund (90.00); a refund committed first stops the waiting release and the release sweep, posting no release journal; released-but-unwithdrawn money returns without leaving a debt');

    // ── Submission, webhook and poll settle exactly once ───────────────────
    const a4 = await paid({ brandId: brand1 });
    const refundA4 = (await request(a4.order.id)).id;
    const [refundA2, refundA3] = [requestA2.id, requestA3.id];
    await only([refundA1, refundA2, refundA3, refundA4]);
    assert.deepEqual(await refunds.processPending(), { processed: 4, stale: 0 });
    for (const [id, capture] of [[refundA1, a1], [refundA2, a2], [refundA3, a3], [refundA4, a4]]) {
      const row = await refundRow(id);
      assert.equal(row.status, 'PROCESSING');
      assert(row.providerRefundId);
      assert.equal(posts(capture.reference), 1);
      assert.equal(providerRefund(row.providerRefundId).amount, 10000);
    }
    assert.deepEqual(await refunds.processPending(), { processed: 0, stale: 0 });
    providerRefund((await refundRow(refundA1)).providerRefundId).status = 'processed';
    const referenceHook = { event: 'refund.processed', data: { status: 'processed', transaction_reference: a1.reference, amount: '10000', currency: 'NGN' } };
    assert.equal(await refunds.handleWebhook('PAYSTACK', referenceHook), true);
    assert.equal((await refundRow(refundA1)).status, 'SETTLED');
    assert.equal(await refunds.handleWebhook('PAYSTACK', referenceHook), false);
    assert.equal(await settledJournals(refundA1), 1);
    const orderA1 = await prisma.order.findUniqueOrThrow({ where: { id: a1.order.id } });
    assert.equal(orderA1.paymentStatus, 'REFUNDED');
    const holdA1 = await prisma.escrowHold.findUniqueOrThrow({ where: { id: a1.hold.id } });
    assert.equal(holdA1.status, 'REFUNDED');
    assert(holdA1.refundedAt);
    const a3ProviderId = (await refundRow(refundA3)).providerRefundId;
    providerRefund(a3ProviderId).status = 'processed';
    assert.equal(await refunds.handleWebhook('PAYSTACK', { event: 'refund.processed', data: { id: Number(a3ProviderId), status: 'processed' } }), true);
    assert.equal((await refundRow(refundA3)).status, 'SETTLED');
    providerRefund((await refundRow(refundA2)).providerRefundId).status = 'processed';
    providerRefund((await refundRow(refundA4)).providerRefundId).status = 'failed';
    await only([refundA2, refundA4]);
    await refunds.processPending();
    assert.equal((await refundRow(refundA2)).status, 'SETTLED');
    const failedA4 = await refundRow(refundA4);
    assert.equal(failedA4.status, 'NEEDS_ATTENTION');
    assert.equal(failedA4.lastError, 'REFUND_PROVIDER_FAILED');
    assert.equal(await settledJournals(refundA4), 0);
    assert.equal((await prisma.escrowHold.findUniqueOrThrow({ where: { id: a4.hold.id } })).status, 'REFUND_PENDING');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: a4.order.id } })).paymentStatus, 'PAID');
    for (const id of [refundA1, refundA2, refundA3]) assert.equal(await settledJournals(id), 1);
    assert.equal(await refunds.notifySettled(), 3);
    assert.equal(await refunds.notifySettled(), 0);
    assert.deepEqual(buyerNotices.map((notice) => notice.notificationId).sort(), [refundA1, refundA2, refundA3].sort());
    assert(buyerNotices.every((notice) => notice.recipientId === buyer && notice.payload.refundStatus === 'PROCESSED'));
    evidence.cases.push('four refunds submit once each to the simulator; a reference-only webhook, a refund-id webhook and a status poll each settle money, escrow and order exactly once; replays post nothing; a provider-failed refund keeps its reservation and goes to a person; shoppers get one processed notice per settled refund');

    // ── Uncertain outcomes are looked up, never resent ─────────────────────
    const b1 = await paid({ brandId: brand1 });
    const refundB1 = (await request(b1.order.id)).id;
    simulator.state.modes.set(b1.reference, 'drop');
    await only([refundB1]);
    await refunds.processPending();
    const linkedB1 = await refundRow(refundB1);
    assert.equal(linkedB1.status, 'PROCESSING');
    assert.equal(providerRefund(linkedB1.providerRefundId).reference, b1.reference);
    await only([refundB1]);
    await refunds.processPending();
    await refunds.processPending();
    assert.equal(posts(b1.reference), 1);
    evidence.cases.push('a submission whose answer is lost is found by its note at the provider and linked; the refund is never sent a second time');

    const b1b = await paid({ brandId: brand1 });
    const refundB1b = (await request(b1b.order.id)).id;
    simulator.state.modes.set(b1b.reference, 'drop-buried');
    await only([refundB1b]);
    await refunds.processPending();
    const linkedB1b = await refundRow(refundB1b);
    assert.equal(linkedB1b.status, 'PROCESSING');
    assert.equal(providerRefund(linkedB1b.providerRefundId).reference, b1b.reference);
    assert.equal(posts(b1b.reference), 1);
    evidence.cases.push('the lookup uses only documented List Refunds parameters (page, perPage, from) and pages past 150 newer refunds to find the lost one; still never resent');

    const b2 = await paid({ brandId: brand1 });
    const refundB2 = (await request(b2.order.id)).id;
    simulator.state.modes.set(b2.reference, 'drop');
    simulator.state.listDown = true;
    await only([refundB2]);
    await refunds.processPending();
    simulator.state.listDown = false;
    const attentionB2 = await refundRow(refundB2);
    assert.equal(attentionB2.status, 'NEEDS_ATTENTION');
    assert.equal(attentionB2.lastError, 'REFUND_GATEWAY_OUTCOME_UNKNOWN');
    assert.equal(await prisma.operationalAlert.count({ where: { dedupeKey: `standard-refund:${refundB2}:attention`, status: 'OPEN' } }), 1);
    await prisma.standardOrderRefund.update({ where: { id: refundB2 }, data: { nextAttemptAt: new Date(0) } });
    await refunds.processPending();
    await refunds.processPending();
    assert.equal(posts(b2.reference), 1);
    assert.equal((await refundRow(refundB2)).status, 'NEEDS_ATTENTION');
    const controller = new AdminOrderController({}, refunds);
    const actor = { user: { id: adminId } };
    await rejectsWith(
      controller.reconcileRefund(refundB2, { providerRefundId: (await refundRow(refundA1)).providerRefundId }, actor),
      /REFUND_PROVIDER_RECONCILIATION_MISMATCH/,
    );
    await rejectsWith(controller.reconcileRefund(refundB2, { providerRefundId: '999999' }, actor), /REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE/);
    const createdB2 = [...simulator.state.refunds.values()].find((refund) => refund.reference === b2.reference);
    const reconciledB2 = await controller.reconcileRefund(refundB2, { providerRefundId: String(createdB2.id) }, actor);
    assert.equal(reconciledB2.status, 'PROCESSING');
    createdB2.status = 'processed';
    await refunds.handleWebhook('PAYSTACK', { event: 'refund.processed', data: { transaction_reference: b2.reference, status: 'processed' } });
    assert.equal((await refundRow(refundB2)).status, 'SETTLED');
    assert.equal(await prisma.operationalAlert.count({ where: { dedupeKey: `standard-refund:${refundB2}:attention`, status: 'RESOLVED' } }), 1);
    assert.equal(await prisma.paymentEvent.count({ where: { type: 'STANDARD_ORDER_REFUND_RECONCILED', paymentAttemptId: b2.capture.id } }), 1);
    assert.equal(posts(b2.reference), 1);
    evidence.cases.push('a lost answer with the provider lookup unavailable stops at NEEDS_ATTENTION with an open alert and is never resent; the admin reconcile route rejects another capture\'s refund and an unknown id, links the verified one and the settlement resolves the alert');

    const b3 = await paid({ brandId: brand1 });
    const refundB3 = (await request(b3.order.id)).id;
    const b4 = await paid({ brandId: brand1 });
    const refundB4 = (await request(b4.order.id)).id;
    simulator.state.refunds.set('6999', {
      id: 6999, reference: b4.reference, transactionId: Number(b4.capture.providerTransactionId),
      amount: 10000, currency: 'NGN', note: `WIEZ standard refund ${refundB4}`, status: 'pending',
    });
    await only([]);
    await prisma.standardOrderRefund.updateMany({
      where: { id: { in: [refundB3, refundB4] } },
      data: { status: 'SUBMITTING', leaseToken: randomUUID(), lockedAt: new Date(Date.now() - 11 * 60000), attempts: 1 },
    });
    assert.deepEqual(await refunds.processPending(), { processed: 0, stale: 2 });
    assert.equal((await refundRow(refundB3)).status, 'NEEDS_ATTENTION');
    const linkedB4 = await refundRow(refundB4);
    assert.equal(linkedB4.status, 'PROCESSING');
    assert.equal(linkedB4.providerRefundId, '6999');
    assert.equal(posts(b3.reference) + posts(b4.reference), 0);
    evidence.cases.push('an interrupted submission (stale lease) is never resubmitted: it links the refund the provider holds, or waits for a person when there is none');

    const b5 = await paid({ brandId: brand1 });
    const refundB5 = (await request(b5.order.id)).id;
    simulator.state.modes.set(b5.reference, 'reject400');
    await only([refundB5]);
    await refunds.processPending();
    const failedB5 = await refundRow(refundB5);
    assert.equal(failedB5.status, 'FAILED');
    assert.equal(failedB5.lastError, 'REFUND_GATEWAY_HTTP_400');
    assert(failedB5.nextAttemptAt > new Date());
    simulator.state.modes.set(b5.reference, 'accept');
    await only([refundB5]);
    await refunds.processPending();
    const retriedB5 = await refundRow(refundB5);
    assert.equal(retriedB5.status, 'PROCESSING');
    assert.equal(retriedB5.attempts, 2);
    assert.equal(posts(b5.reference), 2);
    assert.equal([...simulator.state.refunds.values()].filter((refund) => refund.reference === b5.reference).length, 1);
    evidence.cases.push('a definitive provider rejection fails with backoff and is retried; the provider holds exactly one refund afterwards');

    const b6 = await paid({ brandId: brand1 });
    const refundB6 = (await request(b6.order.id)).id;
    const gate = { arrived: deferred(), release: deferred() };
    simulator.state.gates.set(b6.reference, gate);
    simulator.state.modes.set(b6.reference, 'slow');
    await only([refundB6]);
    const slowRun = refunds.processPending();
    const lateRefund = await gate.arrived.promise;
    await prisma.standardOrderRefund.update({ where: { id: refundB6 }, data: { leaseToken: randomUUID() } });
    gate.release.resolve();
    await slowRun;
    const lostB6 = await refundRow(refundB6);
    assert.equal(lostB6.status, 'NEEDS_ATTENTION');
    assert.equal(lostB6.lastError, 'REFUND_SUBMISSION_LEASE_LOST');
    assert.equal(lostB6.providerRefundId, String(lateRefund.id));
    lateRefund.status = 'processed';
    assert.equal((await controller.reconcileRefund(refundB6, { providerRefundId: String(lateRefund.id) }, actor)).status, 'SETTLED');
    assert.equal(posts(b6.reference), 1);
    evidence.cases.push('a provider answer that arrives after the lease was lost keeps the refund id it created, goes to a person, and reconciles to one settlement');

    const mockRun = await paid({ brandId: brand1, mode: 'mock' });
    const refundMock = (await request(mockRun.order.id)).id;
    await only([refundMock]);
    await refunds.processPending();
    assert.equal((await refundRow(refundMock)).lastError, 'REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED');
    const mockAllowed = await paid({ brandId: brand1, mode: 'mock' });
    const refundAllowed = (await request(mockAllowed.order.id)).id;
    process.env.NODE_ENV = 'test';
    process.env.STANDARD_ORDER_REFUND_SIMULATION_ENABLED = 'true';
    try {
      await only([refundAllowed]);
      await refunds.processPending();
    } finally {
      delete process.env.STANDARD_ORDER_REFUND_SIMULATION_ENABLED;
      if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv.NODE_ENV;
    }
    const simulated = await refundRow(refundAllowed);
    assert.equal(simulated.status, 'SETTLED');
    assert.equal(simulated.providerRefundId, `simulated:${refundAllowed}`);
    assert.equal(posts(mockRun.reference) + posts(mockAllowed.reference), 0);
    assert.equal(simulator.state.unauthorized, 0);
    evidence.cases.push('mock-mode captures never reach a provider: without explicit test simulation they wait for a person, with it they settle through the same ledger path');

    // ── Debt: a refund after payout, FIFO recovery from later earnings ─────
    const p1 = await paid({ brandId: brand2 });
    await prisma.payout.create({ data: { id: randomUUID(), brandId: brand2, amount: 27, currency: 'NGN', status: 'PAID', reference: `fixture-${randomUUID()}` } });
    assert.equal((await loadBrandPosition(prisma, brand2, 'NGN')).position.toFixed(2), '0.00');
    await request(p1.order.id, 'RETURN');
    const debt = await balance.getDebtSnapshot(brand2);
    assert.equal(debt.outstanding, 27);
    assert.equal(debt.count, 1);
    assert.equal(debt.inDebt, true);
    const clawbackP1 = await prisma.brandBalanceAdjustment.findFirstOrThrow({ where: { brandId: brand2 } });
    assert.equal(clawbackP1.status, 'OUTSTANDING');
    const p2 = await paid({ brandId: brand2, amount: 50 });
    const afterP2 = await prisma.brandBalanceAdjustment.findUniqueOrThrow({ where: { id: clawbackP1.id } });
    assert.equal(afterP2.status, 'PARTIALLY_RECOVERED');
    assert.equal(afterP2.recoveredAmount.toFixed(2), '13.50');
    assert.equal((await balance.getDebtSnapshot(brand2)).outstanding, 13.5);
    const p3 = await paid({ brandId: brand2 });
    const afterP3 = await prisma.brandBalanceAdjustment.findUniqueOrThrow({ where: { id: clawbackP1.id } });
    assert.equal(afterP3.status, 'RECOVERED');
    const recoveries = await prisma.brandBalanceRecovery.findMany({ where: { adjustmentId: clawbackP1.id }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(recoveries.map((row) => [row.amount.toFixed(2), row.orderId]), [['13.50', p2.order.id], ['13.50', p3.order.id]]);
    assert.equal((await loadBrandPosition(prisma, brand2, 'NGN')).position.toFixed(2), '13.50');
    const payable = await prisma.$transaction((tx) => balance.payableFromRelease(tx, { brandId: brand2, amount: 20 }));
    assert.deepEqual([payable.payable.toFixed(2), payable.withheld.toFixed(2)], ['13.50', '6.50']);
    evidence.cases.push('a refund after the brand was paid out leaves a 27.00 debt; the next two releases (13.50 each) pay it down oldest-first with one statement line per order, and payout availability is capped by the position');

    const sourceKey = `fixture-source-${randomUUID()}`;
    const raise = (amount) =>
      prisma.$transaction((tx) => balance.raiseAdjustment(tx, { brandId: brand3, type: 'MANUAL_DEBIT', amount, reason: 'Fixture debit', sourceKey }), { timeout: 20000 });
    const raised = await Promise.all([raise(5), raise(5), raise(5)]);
    assert.equal(new Set(raised.map((row) => row.id)).size, 1);
    assert.equal(await prisma.brandBalanceAdjustment.count({ where: { sourceKey } }), 1);
    await rejectsWith(raise(6), /BRAND_ADJUSTMENT_SOURCE_CONFLICT/);
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await balance.raiseAdjustment(tx, { brandId: brand3, type: 'MANUAL_DEBIT', amount: 9, reason: 'Rolled back', sourceKey: 'fixture-rollback' });
        throw Error('Fixture rollback');
      }),
      /Fixture rollback/,
    );
    assert.equal(await prisma.brandBalanceAdjustment.count({ where: { sourceKey: 'fixture-rollback' } }), 0);
    await rejectsWith(prisma.brandBalanceRecovery.create({ data: { adjustmentId: raised[0].id, amount: 1, currency: 'USD' } }), /BRAND_RECOVERY_CURRENCY_MISMATCH/);
    await rejectsWith(
      prisma.brandBalanceAdjustment.create({ data: { brandId: brand3, type: 'MANUAL_DEBIT', amount: 0, currency: 'NGN', reason: 'Zero' } }),
      /BrandBalanceAdjustment_amounts|check constraint/i,
    );
    const ownerNotices = [];
    const announcer = new BrandBalanceService(prisma, {
      create: async (recipientId, type, opts) => {
        ownerNotices.push({ recipientId, type, ...opts });
      },
    });
    while ((await announcer.announcePending()) > 0);
    assert.equal(await announcer.announcePending(), 0);
    const brand2Notices = ownerNotices.filter((notice) => notice.recipientId === owner2);
    assert.equal(brand2Notices.length, 3);
    assert.equal(new Set(ownerNotices.map((notice) => notice.notificationId)).size, ownerNotices.length);
    assert(!ownerNotices.some((notice) => notice.payload.amount === 9));
    evidence.cases.push('one system adjustment per source key under concurrency, conflicting amounts and rolled-back adjustments refused; a recovery can never change currency; owner notices are sent once per committed row, after commit');

    // ── Ledger guards ──────────────────────────────────────────────────────
    const ledgerLines = (amount) => [
      { code: 'fixture:cash', name: 'Cash', type: 'ASSET', subType: 'FIXTURE', isSystemAccount: true, direction: 'DEBIT', amount },
      { code: 'fixture:payable', name: 'Payable', type: 'LIABILITY', subType: 'FIXTURE', isSystemAccount: true, direction: 'CREDIT', amount },
    ];
    for (const [currency, amount] of [['NGN', 10], ['USD', 3]])
      await prisma.$transaction((tx) =>
        ledger.postTransaction(tx, { idempotencyKey: `fixture:${currency}`, type: 'PAYMENT_RECEIVED', description: 'Currency fixture', totalAmount: amount, currency, lines: ledgerLines(amount) }),
      );
    const cash = await prisma.ledgerAccount.findMany({ where: { code: 'fixture:cash' }, orderBy: { currency: 'asc' } });
    assert.deepEqual(cash.map((row) => [row.currency, row.currentBalance.toFixed(2)]), [['NGN', '10.00'], ['USD', '3.00']]);
    await rejectsWith(
      prisma.$executeRawUnsafe(`UPDATE "LedgerEntry" SET amount = amount + 1 WHERE "transactionId" = (SELECT id FROM "LedgerTransaction" WHERE "idempotencyKey" = 'fixture:NGN')`),
      /LEDGER_ENTRY_IMMUTABLE/,
    );
    await rejectsWith(
      prisma.$transaction(async (tx) => {
        const txn = await tx.ledgerTransaction.create({ data: { idempotencyKey: 'fixture:mixed', type: 'PAYMENT_RECEIVED', description: 'Mixed', totalAmount: 1, currency: 'USD', baseCurrency: 'USD', baseCurrencyAmount: 1 } });
        await tx.ledgerEntry.create({ data: { transactionId: txn.id, accountId: cash[0].id, direction: 'DEBIT', amount: 1, balanceAfter: 0 } });
      }),
      /LEDGER_ENTRY_CURRENCY_MISMATCH/,
    );
    await rejectsWith(
      prisma.$transaction(async (tx) => {
        const txn = await tx.ledgerTransaction.create({ data: { idempotencyKey: 'fixture:unbalanced', type: 'PAYMENT_RECEIVED', description: 'Unbalanced', totalAmount: 5, currency: 'NGN', baseCurrency: 'NGN', baseCurrencyAmount: 5 } });
        await tx.ledgerEntry.create({ data: { transactionId: txn.id, accountId: cash[0].id, direction: 'DEBIT', amount: 5, balanceAfter: 0 } });
      }),
      /LEDGER_UNBALANCED_TRANSACTION/,
    );
    assert.equal(await prisma.ledgerTransaction.count({ where: { idempotencyKey: { in: ['fixture:mixed', 'fixture:unbalanced'] } } }), 0);
    await rejectsWith(
      prisma.$transaction((tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "LedgerEntry" WHERE id = (SELECT e.id FROM "LedgerEntry" e JOIN "LedgerTransaction" t ON t.id = e."transactionId" WHERE t."idempotencyKey" = 'fixture:NGN' AND e.direction = 'DEBIT')`),
      ),
      /LEDGER_UNBALANCED_TRANSACTION/,
    );
    assert.equal(await prisma.ledgerEntry.count({ where: { transactionId: (await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: 'fixture:NGN' } })).id } }), 2);
    const unbalancedJournals = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId"
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)) unbalanced`);
    assert.equal(unbalancedJournals[0].count, 0);
    evidence.cases.push('ledger accounts are (code, currency): NGN and USD postings never share a balance; entries cannot be edited or posted across currencies, and a transaction left unbalanced by an insert or a delete is refused at commit; every journal written by this run balances');

    // ── Tag targets and the primary-membership projection ──────────────────
    const tag = await prisma.tag.create({ data: { id: randomUUID(), normalizedName: `fixture-${randomUUID()}`, displayName: 'Fixture' } });
    const taggedProduct = await prisma.product.create({ data: { id: randomUUID(), brandId: brand1, name: 'Tag fixture', price: 10 } });
    const shelf = await prisma.storeCollection.create({ data: { id: randomUUID(), ownerId: owner1, title: 'Fixture shelf' } });
    const design = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner1, title: 'Fixture design' } });
    const bind = (entityType, entityId) => prisma.tagBinding.create({ data: { id: randomUUID(), tagId: tag.id, entityType, entityId } });
    await bind('PRODUCT', taggedProduct.id);
    await bind('STORE_COLLECTION', shelf.id);
    await bind('COLLECTION', design.id);
    await rejectsWith(bind('COLLECTION', shelf.id), /TagBinding_designId_fkey|Foreign key/i);
    await rejectsWith(bind('STORE_COLLECTION', design.id), /TagBinding_storeCollectionId_fkey|Foreign key/i);
    await rejectsWith(bind('PRODUCT', randomUUID()), /TagBinding_productId_fkey|Foreign key/i);
    await prisma.product.delete({ where: { id: taggedProduct.id } });
    await prisma.storeCollection.delete({ where: { id: shelf.id } });
    assert.deepEqual((await prisma.tagBinding.findMany({ where: { tagId: tag.id } })).map((row) => row.entityType), ['COLLECTION']);
    evidence.cases.push('tag bindings reference real typed targets: a store collection cannot be tagged as a design or the reverse, a missing target is refused, and deleting a product or store collection removes its bindings');

    const [shelfA, shelfB] = [randomUUID(), randomUUID()];
    await prisma.storeCollection.createMany({ data: [shelfA, shelfB].map((id) => ({ id, ownerId: owner1, title: 'Membership fixture' })) });
    const member = await prisma.product.create({ data: { id: randomUUID(), brandId: brand1, name: 'Membership fixture', price: 10 } });
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: member.id }, data: { collectionId: shelfA } });
      await tx.storeCollectionProduct.create({ data: { id: randomUUID(), collectionId: shelfA, productId: member.id, isPrimary: true } });
    });
    await rejectsWith(
      prisma.$transaction((tx) => tx.product.update({ where: { id: member.id }, data: { collectionId: shelfB } })),
      /PRODUCT_PRIMARY_COLLECTION_PROJECTION_MISMATCH/,
    );
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: member.id } })).collectionId, shelfA);
    await prisma.$transaction(async (tx) => {
      await tx.storeCollectionProduct.create({ data: { id: randomUUID(), collectionId: shelfB, productId: member.id, isPrimary: false } });
      await tx.storeCollectionProduct.updateMany({ where: { productId: member.id, collectionId: shelfA }, data: { isPrimary: false } });
      await tx.storeCollectionProduct.updateMany({ where: { productId: member.id, collectionId: shelfB }, data: { isPrimary: true } });
      await tx.product.update({ where: { id: member.id }, data: { collectionId: shelfB } });
    });
    await rejectsWith(
      prisma.storeCollectionProduct.updateMany({ where: { productId: member.id, collectionId: shelfB }, data: { isPrimary: false } }),
      /PRODUCT_PRIMARY_COLLECTION_PROJECTION_MISMATCH/,
    );
    evidence.cases.push('Product.collectionId always equals the single primary membership at commit: pointer-only or flag-only changes are refused, and a move written in any statement order commits');

    // ── Product removal and checkout ───────────────────────────────────────
    const storeNotices = [];
    const store = Object.assign(Object.create(StoreService.prototype), {
      prisma,
      standardOrderRefunds: refunds,
      notifications: {
        create: async (recipientId, type, opts) => {
          storeNotices.push({ recipientId, type, ...opts });
        },
      },
      logger: { log() {}, debug() {}, warn() {}, error() {} },
    });
    const product = async () => {
      const row = await prisma.product.create({ data: { id: randomUUID(), brandId: brand1, name: 'Removal fixture', price: 100 } });
      const shelfId = randomUUID();
      await prisma.storeCollection.create({ data: { id: shelfId, ownerId: owner1, title: 'Removal shelf' } });
      await prisma.$transaction(async (tx) => {
        await tx.storeCollectionProduct.create({ data: { id: randomUUID(), collectionId: shelfId, productId: row.id, isPrimary: true } });
        await tx.product.update({ where: { id: row.id }, data: { collectionId: shelfId } });
      });
      return row;
    };
    const removed = await product();
    const removedOrder = await paid({ brandId: brand1, productId: removed.id });
    await rejectsWith(store.deleteProduct(owner1, removed.id, false), /Cannot delete product with active orders/);
    await rejectsWith(store.deleteProduct(owner2, removed.id, true), /only delete your own products/);
    const removal = await store.deleteProduct(owner1, removed.id, true);
    assert.deepEqual(removal.cancelledOrders, [{ orderId: removedOrder.order.id, refundStatus: 'PENDING' }]);
    const removalRefund = await prisma.standardOrderRefund.findUniqueOrThrow({ where: { orderId: removedOrder.order.id } });
    assert.equal(removalRefund.trigger, 'PRODUCT_REMOVAL');
    assert.equal(removalRefund.status, 'REQUESTED');
    const removedRow = await prisma.product.findUniqueOrThrow({ where: { id: removed.id } });
    assert(removedRow.deletedAt);
    assert.equal(removedRow.collectionId, null);
    assert.equal(await prisma.storeCollectionProduct.count({ where: { productId: removed.id } }), 0);
    const cancelledOrder = await prisma.order.findUniqueOrThrow({ where: { id: removedOrder.order.id } });
    assert.deepEqual([cancelledOrder.status, cancelledOrder.paymentStatus], ['CANCELLED', 'PAID']);
    assert.equal(storeNotices.length, 1);
    assert.equal(storeNotices[0].payload.refundStatus, 'PENDING');
    assert.match(storeNotices[0].payload.message, /requested and is being processed/);
    assert.equal((await store.deleteProduct(owner1, removed.id, true)).message, 'Product already deleted');
    assert.equal(await prisma.standardOrderRefund.count({ where: { orderId: removedOrder.order.id } }), 1);

    const shipped = await product();
    await paid({ brandId: brand1, productId: shipped.id, status: 'SHIPPED' });
    await rejectsWith(store.deleteProduct(owner1, shipped.id, true), /PRODUCT_HAS_SHIPPED_ORDERS/);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: shipped.id } })).deletedAt, null);

    const contested = await product();
    const checkoutHeld = deferred(),
      checkoutGo = deferred();
    const checkout = prisma.$transaction(
      async (tx) => {
        const locked = await lockCheckoutProducts(tx, [contested.id]);
        assert(isSellableAfterLock(locked.get(contested.id)));
        checkoutHeld.resolve();
        await checkoutGo.promise;
        const session = await tx.checkoutSession.create({
          data: { buyerId: buyer, idempotencyKey: randomUUID(), subtotal: 100, grandTotal: 100, expiresAt: new Date(Date.now() + 1800000) },
        });
        await tx.checkoutSessionLine.create({
          data: { checkoutSessionId: session.id, lineType: 'STANDARD_ITEM', productId: contested.id, unitPrice: 100, lineTotal: 100, itemSnapshotJson: {} },
        });
      },
      { timeout: 20000 },
    );
    await checkoutHeld.promise;
    const deleting = store.deleteProduct(owner1, contested.id, true);
    try {
      await waitForBlocked();
    } finally {
      checkoutGo.resolve();
    }
    await checkout;
    await rejectsWith(deleting, /PRODUCT_CHECKOUT_IN_PROGRESS/);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: contested.id } })).deletedAt, null);

    const late = await product();
    const deleteHeld = deferred(),
      deleteGo = deferred();
    const removing = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "_id" FROM "Product" WHERE "_id" = ${late.id}::uuid FOR UPDATE`;
        await tx.storeCollectionProduct.deleteMany({ where: { productId: late.id } });
        await tx.product.update({ where: { id: late.id }, data: { deletedAt: new Date(), isActive: false, collectionId: null } });
        deleteHeld.resolve();
        await deleteGo.promise;
      },
      { timeout: 20000 },
    );
    await deleteHeld.promise;
    const lateCheckout = prisma.$transaction(async (tx) => {
      const locked = await lockCheckoutProducts(tx, [late.id]);
      return isSellableAfterLock(locked.get(late.id));
    }, { timeout: 20000 });
    try {
      await waitForBlocked();
    } finally {
      deleteGo.resolve();
    }
    await removing;
    assert.equal(await lateCheckout, false);
    evidence.cases.push('product deletion cancels unshipped paid orders through the canonical refund (pending wording, one refund on replay), refuses shipped orders and a checkout committed while it waited, and a checkout that waited on a deletion sees the product as unsellable');

    evidence.paystackSimulator = {
      refundSubmissions: [...simulator.state.posts.values()].reduce((sum, count) => sum + count, 0),
      providerRefunds: simulator.state.refunds.size,
      unauthorizedRequests: simulator.state.unauthorized,
    };
    assert.equal(simulator.state.unauthorized, 0);
    evidence.passed = true;
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    simulator.server.closeAllConnections?.();
    await new Promise((resolve) => simulator.server.close(() => resolve()));
    if (prisma) await prisma.$disconnect();
    if (created) {
      assert(/^wiez_refund_integrity_[a-f0-9]{32}$/.test(database));
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`);
      evidence.cleanupPassed = true;
    }
    await admin.end();
    await fs.writeFile(
      path.resolve(__dirname, '../docs/performance-reviews/standard-refund-integrity-postgres-2026-10-26.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    console.log(JSON.stringify(evidence));
  }
}
main().catch((error) => {
  // Validation messages name the model and argument only, never connection details.
  console.error(
    error instanceof assert.AssertionError || error instanceof TypeError
      ? error.message
      : error.name === 'PrismaClientValidationError'
        ? String(error.message).split('\n').slice(-4).join('\n')
        : error.code || error.name || 'Standard refund integrity fixture failed',
  );
  process.exitCode = 1;
});
