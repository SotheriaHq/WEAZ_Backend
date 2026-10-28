const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PaymentService } = require('../src/payment/payment.service');
const { CustomOrdersPaymentsService } = require('../src/custom-orders/custom-orders-payments.service');
const { CustomOrderOpsCronService } = require('../src/custom-order-ops/custom-order-ops.cron.service');
const { CustomOrderSideEffectsService } = require('../src/custom-orders/custom-order-side-effects.service');
const { FinancialDocumentsService } = require('../src/finance/financial-documents.service');
const { CustomOrderThreadBootstrapService } = require('../src/messaging/custom-order-thread-bootstrap.service');
const { MessagingPolicyService } = require('../src/messaging/messaging-policy.service');
const { loadCustomPaymentOrder } = require('../src/custom-orders/custom-payment-order-query');

module.exports = async function verifyCustomPayments({ prisma, queries, simulationUrl, buyer, owner, brand, agreement, finance, queue, createOrder }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_issue_race_[a-f0-9]{32}$/.test(database.name));
  const base = new URL(simulationUrl);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.pathname, '/paystack');
  const saved = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only_not_a_real_key';
  const cases = [], heartbeats = [], warnings = [], messagingHandoffs = [];
  const seed = async transactions => {
    const response = await fetch(`${base}/__fixtures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions }) });
    assert.equal(response.status, 200);
  };
  const stats = async () => {
    const response = await fetch(`${base}/__stats`);
    assert.equal(response.status, 200);
    return (await response.json()).requests;
  };
  const create = async (overrides = {}) => {
    const order = await createOrder();
    await prisma.customOrder.update({ where: { id: order.id }, data: { status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', lane: null, queuePolicyVersion: null, buyerAcceptanceWindowEndsAt: null, ...overrides } });
    const attempt = await prisma.paymentAttempt.create({ data: { reference: `co-query-${randomUUID()}`, subjectType: 'CUSTOM_ORDER', customOrderId: order.id, buyerId: buyer.id, amount: 100, currency: 'NGN', settlementCurrency: 'NGN', settlementAmount: 100, status: 'PENDING', provider: 'PAYSTACK', providerMode: 'live', paymentMethod: 'PAYSTACK', lastVerifiedAt: null } });
    return { order, attempt };
  };
  const providerRow = (row, status = 'success', extra = {}) => ({ reference: row.attempt.reference, status, amount: 10000, currency: 'NGN', paid_at: new Date().toISOString(), ...extra });
  try {
    await prisma.user.updateMany({ where: { id: { in: [buyer.id, owner.id] } }, data: { status: 'ACTIVE' } });
    await prisma.brand.update({ where: { id: brand.id }, data: { verificationStatus: 'APPROVED', activeOrderCapOverride: 0, activeOrderCapOverrideUntil: null, customOrderIntakeBlockedAt: null } });
    await prisma.brandSubscription.update({ where: { id: agreement.id }, data: { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86400000) } });
    const provider = new PaymentService(prisma, {}, {}, {}, {}, {}, undefined, undefined, undefined, undefined, undefined, undefined, base.toString());
    const sideEffects = new CustomOrderSideEffectsService(prisma, {});
    const threads = new CustomOrderThreadBootstrapService(prisma, new MessagingPolicyService(), {
      dispatchMessageOutboxForMessage: async id => messagingHandoffs.push(id),
      emitMessageCreated() {}, emitThreadInvalidation() {},
    });
    const payments = new CustomOrdersPaymentsService(prisma, provider, sideEffects, {}, new FinancialDocumentsService(prisma), threads, finance, queue);
    const cron = new CustomOrderOpsCronService(prisma, sideEffects, {}, payments, { recordCronHeartbeat: async (...args) => heartbeats.push(args) }, {}, queue);
    cron.logger = { warn: message => warnings.push(message), log() {} };
    // Existing disposable scenarios may have pending captures; keep this cron page isolated.
    await prisma.paymentAttempt.updateMany({ where: { subjectType: 'CUSTOM_ORDER' }, data: { lastVerifiedAt: new Date() } });
    const rows = [];
    for (let index = 0; index < 26; index++) rows.push(await create());
    await seed(rows.map(row => providerRow(row)));
    queries.length = 0;
    await cron.reconcilePendingCustomOrderPayments();
    assert.deepEqual(warnings, []);
    assert.equal(heartbeats.at(-1)[2].paid, 26);
    assert.equal((await stats()).length, 26);
    const contextReads = queries.filter(query => /AS "buyerUsername"/.test(query)).length;
    assert.equal(contextReads, 26);
    // One cron identity scan plus one current reference read per command. The private
    // order verifier reuses that read, but still locks/reloads before committing.
    const captureReads = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "public"\."PaymentAttempt"/.test(query)).length;
    assert.equal(captureReads, 27);
    assert.equal(queries.filter(query => /FROM "public"\."(?:UserProfile|FileUpload|Brand)"/.test(query)).length, 0);
    const ids = rows.map(row => row.order.id);
    assert.equal(await prisma.paymentAttempt.count({ where: { id: { in: rows.map(row => row.attempt.id) }, status: 'PAID' } }), 26);
    assert.equal(await prisma.customOrder.count({ where: { id: { in: ids }, paymentStatus: 'PAID', lane: 'PENDING', queuePolicyVersion: 1 } }), 26);
    assert.equal(await prisma.financialDocument.count({ where: { paymentAttemptId: { in: rows.map(row => row.attempt.id) }, type: 'BUYER_RECEIPT' } }), 26);
    assert.equal(await prisma.messageThreadOrderLink.count({ where: { customOrderId: { in: ids } } }), 26);
    const notices = await prisma.customOrderNotificationOutbox.findMany({ where: { customOrderId: { in: ids }, notificationType: { in: ['CUSTOM_ORDER_PAYMENT_RECEIVED', 'CUSTOM_ORDER_REVIEW_REQUIRED'] } } });
    assert(notices.some(row => row.recipientId === buyer.id));
    assert(notices.some(row => row.recipientId === owner.id));
    assert(notices.every(row => row.recipientId === buyer.id || row.recipientId === owner.id));
    const beforeJournals = await prisma.ledgerTransaction.count();
    await cron.reconcilePendingCustomOrderPayments();
    assert.equal(heartbeats.at(-1)[2].scanned, 0);
    await payments.verifyPaymentByReference(buyer.id, { reference: rows[0].attempt.reference, gateway: 'PAYSTACK' });
    assert.equal((await stats()).length, 26);
    assert.equal(await prisma.ledgerTransaction.count(), beforeJournals);
    assert.equal(await prisma.financialDocument.count({ where: { paymentAttemptId: rows[0].attempt.id, type: 'BUYER_RECEIPT' } }), 1);
    cases.push('real custom-payment cron verifies26 captures over local provider HTTP with26 narrow buyer/order/owner JOINs, one scan plus26 reference reads, no profile/media/brand hydration,26 held queue admissions/receipts/thread links and buyer-isolated notices; cron and paid replay add no provider request or money');

    const failed = await create(), pending = await create(), mismatch = await create(), outage = await create();
    await seed([providerRow(failed, 'failed'), providerRow(pending, 'pending'), providerRow(mismatch, 'success', { amount: 1 }), providerRow(outage, 'success', { httpError: 503 })]);
    await cron.reconcilePendingCustomOrderPayments();
    assert.equal(heartbeats.at(-1)[2].scanned, 4);
    assert.equal(heartbeats.at(-1)[2].failed, 2);
    assert.equal((await stats()).length, 4);
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: failed.attempt.id } })).status, 'FAILED');
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: pending.attempt.id } })).status, 'PROCESSING');
    for (const row of [mismatch, outage]) {
      assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: row.attempt.id } })).status, 'PENDING');
      assert.equal(await prisma.financialDocument.count({ where: { paymentAttemptId: row.attempt.id } }), 0);
    }
    assert.equal(await loadCustomPaymentOrder(prisma, failed.order.id, owner.id), null);
    assert.equal(await loadCustomPaymentOrder(prisma, randomUUID(), buyer.id), null);
    await assert.rejects(payments.verifyPaymentByReference(owner.id, { reference: failed.attempt.reference, gateway: 'PAYSTACK' }), /No custom-order payment attempt/);
    await assert.rejects(payments.verifyPayment(buyer.id, failed.order.id, { reference: failed.attempt.reference, gateway: 'FLUTTERWAVE' }), /gateway/);
    assert.equal((await stats()).length, 4);
    const noProfile = await loadCustomPaymentOrder(prisma, failed.order.id, buyer.id);
    assert.equal(noProfile.buyer.userProfile, null);
    await prisma.userProfile.create({ data: { userId: buyer.id, firstName: 'Ada', lastName: 'Query' } });
    const profile = await loadCustomPaymentOrder(prisma, failed.order.id, buyer.id);
    assert.equal(profile.buyer.userProfile.firstName, 'Ada');
    assert.equal(profile.buyer.userProfile.lastName, 'Query');
    cases.push('real provider failed/pending/wrong amount/503 responses retain terminal/pending safeguards without false receipts; wrong buyer/gateway/missing order are refused before transport, missing and present canonical profiles map correctly');
    return { cases, contextReadsFor26: contextReads, attemptPrismaReadsFor26: captureReads, providerRequestsFor26: 26, messagingHandoffs: messagingHandoffs.length };
  } finally {
    if (saved === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = saved;
  }
};
