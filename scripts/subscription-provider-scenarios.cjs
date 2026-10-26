const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SubscriptionsService } = require('../src/subscriptions/subscriptions.service');
const { SubscriptionPaystackService } = require('../src/subscriptions/subscription-paystack.service');
const { BrandAccessService } = require('../src/brands/brand-access.service');
const { encryptSubscriptionAuthorization } = require('../src/subscriptions/subscription-authorization.crypto');

// Called only by the loopback-only, randomly named disposable-database harness.
module.exports = async function verifySubscriptionProvider(prisma, queries, simulationUrl) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_ledger_race_[a-f0-9]{32}$/.test(database.name), 'Disposable regression database required');
  const base = new URL(simulationUrl);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.pathname, '/paystack');
  const saved = Object.fromEntries(['PAYMENTS_MODE', 'PAYSTACK_SECRET_KEY', 'PAYMENT_SAVED_METHODS_SECRET'].map(key => [key, process.env[key]]));
  process.env.PAYMENTS_MODE = 'live';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only_not_a_real_key';
  process.env.PAYMENT_SAVED_METHODS_SECRET = 'fixture-only-key-with-no-actual-card-data';
  const cases = [];
  const seed = async transactions => {
    const response = await fetch(`${base}/__fixtures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions }) });
    assert.equal(response.status, 200);
  };
  const stats = async () => {
    const response = await fetch(`${base}/__stats`);
    assert.equal(response.status, 200);
    return (await response.json()).requests;
  };
  const now = new Date();
  const create = async (purpose = 'INITIAL', overrides = {}) => {
    const owner = await prisma.user.create({ data: { id: randomUUID(), username: `billing-http-${randomUUID()}`, email: `${randomUUID()}@example.invalid` } });
    const brand = await prisma.brand.create({ data: { id: randomUUID(), ownerId: owner.id, name: 'HTTP billing fixture' } });
    const periodStart = purpose === 'RENEWAL' ? new Date(+now - 3600000) : now;
    const agreement = await prisma.brandSubscription.create({ data: {
      brandId: brand.id, tierKey: 'THREAD', priceSnapshotNgn: 10000,
      status: purpose === 'RENEWAL' ? 'PAST_DUE' : 'PENDING',
      currentPeriodStart: new Date(+periodStart - 30 * 86400000), currentPeriodEnd: periodStart,
      providerCustomerEmail: owner.email, recurringConsentAt: now,
      recurringPolicyVersion: 'fixture', providerAuthorizationCode: encryptSubscriptionAuthorization('AUTH_fixture_renewal', brand.id),
    } });
    const invoice = await prisma.brandSubscriptionInvoice.create({ data: { subscriptionId: agreement.id, reference: `wzsub-${randomUUID()}`, purpose, amount: 10000, currency: 'NGN', status: 'PENDING', periodStart, periodEnd: new Date(+periodStart + 30 * 86400000), payerEmail: owner.email, nextAttemptAt: now, ...overrides } });
    return { owner, brand, agreement, invoice };
  };
  const providerRow = (row, reference = row.invoice.reference, status = 'failed', extra = {}) => ({ reference, status, amount: 1000000, currency: 'NGN', email: row.owner.email, paid_at: now.toISOString(), ...extra });
  try {
    await prisma.subscriptionTier.upsert({ where: { key: 'THREAD' }, create: { key: 'THREAD', name: 'Thread', monthlyPriceNgn: 10000 }, update: {} });
    const billing = new SubscriptionsService(prisma, new BrandAccessService(prisma), {}, new SubscriptionPaystackService(base.toString()));
    const failed = await create('RENEWAL', { status: 'FAILED', attemptCount: 1 });
    await seed([providerRow(failed), providerRow(failed, `${failed.invoice.reference}-a1`)]);
    const hosted = await billing.prepareHostedPayment(failed.invoice.id, 'changed@example.invalid');
    assert(hosted.reference.startsWith(`${failed.invoice.reference}-h`));
    assert.equal(hosted.email, failed.owner.email);
    assert.deepEqual((await stats()).map(row => row.method), ['GET', 'GET']);
    cases.push('hosted recovery verifies both definitive failed references over real HTTP before reserving a new reference, retains original payer identity and makes no debit');

    const uncertain = await create('RENEWAL', { status: 'FAILED', attemptCount: 1 });
    await seed([]);
    await assert.rejects(billing.prepareHostedPayment(uncertain.invoice.id, uncertain.owner.email), /uncertain/);
    assert.equal((await stats()).length, 2);
    assert.equal((await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: uncertain.invoice.id } })).hostedReference, null);
    cases.push('missing automatic-attempt reference returns the documented missing response over HTTP and blocks another hosted payment without a charge');

    const pending = await create('RENEWAL');
    await seed([providerRow(pending, pending.invoice.reference, 'pending')]);
    await assert.rejects(billing.prepareHostedPayment(pending.invoice.id, pending.owner.email), /pending/);
    await billing.processInvoice(pending.invoice.id, now);
    assert.equal((await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: pending.invoice.id } })).status, 'ACTION_REQUIRED');
    assert((await stats()).every(row => row.method === 'GET'));
    cases.push('pending reference blocks both hosted recovery and claimed invoice reconciliation from issuing a second debit');

    for (const mismatch of [{ amount: 1 }, { currency: 'USD' }, { email: 'wrong@example.invalid' }]) {
      const row = await create();
      await seed([providerRow(row, row.invoice.reference, 'success', mismatch)]);
      await assert.rejects(billing.verifyForOwner(row.owner.id, row.brand.id, row.invoice.reference), /billing review/);
      assert.equal((await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: row.invoice.id } })).status, 'PAYMENT_REVIEW');
      assert.equal((await prisma.brandSubscription.findUniqueOrThrow({ where: { id: row.agreement.id } })).status, 'PENDING');
      assert.equal(await prisma.brandSubscriptionPaymentCapture.count({ where: { invoiceId: row.invoice.id } }), 0);
    }
    cases.push('real HTTP amount, currency and payer-email mismatches move invoices to review without recording a capture or granting entitlement');

    const outage = await create('RENEWAL');
    await seed([providerRow(outage, outage.invoice.reference, 'failed', { httpError: 503 })]);
    await billing.processInvoice(outage.invoice.id, now);
    const afterOutage = await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: outage.invoice.id } });
    assert.equal(afterOutage.lockedAt, null);
    assert.equal(afterOutage.attemptCount, 0);
    assert(afterOutage.nextAttemptAt > now);
    assert((await stats()).every(row => row.method === 'GET'));
    cases.push('provider503 through real fetch leaves no charge, unlocks invoice and schedules reconciliation of the existing reference');

    // Keep the selected cron page isolated from the preceding synthetic failure cases.
    await prisma.brandSubscriptionInvoice.updateMany({ data: { nextAttemptAt: null } });
    await prisma.brandSubscription.updateMany({ data: { status: 'CANCELLED' } });
    const automatic = [];
    for (let index = 0; index < 26; index++) automatic.push(await create('RENEWAL'));
    await seed([]);
    queries.length = 0;
    await billing.processBilling();
    const debitJoins = queries.filter(query => /^\s*SELECT\b/i.test(query) && /AS "sourceStatus"/.test(query) && /JOIN "SavedPaymentMethod"/.test(query)).length;
    const invoiceJoins = queries.filter(query => /^\s*SELECT\b/i.test(query) && /FROM "BrandSubscriptionInvoice" i/.test(query) && /AS "agreementCustomerEmail"/.test(query)).length;
    assert.equal(debitJoins, 26);
    assert.equal(invoiceJoins, 52);
    const ids = automatic.map(row => row.invoice.id);
    assert.equal(await prisma.brandSubscriptionInvoice.count({ where: { id: { in: ids }, status: 'PAID' } }), 26);
    assert.equal(await prisma.brandSubscriptionPaymentCapture.count({ where: { invoiceId: { in: ids }, status: 'APPLIED' } }), 26);
    const requestLog = await stats();
    const charges = requestLog.filter(row => row.path === '/transaction/charge_authorization');
    assert.equal(charges.length, 26);
    assert.equal(requestLog.length, 78);
    assert(automatic.every(row => charges.filter(request => request.reference === `${row.invoice.reference}-a1`).length === 1));
    await billing.processBilling();
    assert.equal((await stats()).length, 78);
    assert.equal(await prisma.brandSubscriptionPaymentCapture.count({ where: { invoiceId: { in: ids } } }), 26);
    cases.push('real billing cron processes26 renewals with26 fresh agreement/source/card JOINs and78 HTTP requests, records one confirmed capture per invoice and repeats without another provider call or entitlement extension');

    const blocked = await create('RENEWAL');
    const wrongOwnerCard = await prisma.savedPaymentMethod.create({ data: { buyerId: automatic[0].owner.id, provider: 'PAYSTACK', paymentMethod: 'PAYSTACK', last4: '4242', status: 'ACTIVE' } });
    await prisma.brandSubscription.update({ where: { id: blocked.agreement.id }, data: { savedPaymentMethodId: wrongOwnerCard.id } });
    await seed([]);
    await billing.processInvoice(blocked.invoice.id, now);
    assert.equal((await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: blocked.invoice.id } })).status, 'ACTION_REQUIRED');
    assert((await stats()).every(row => row.method === 'GET'));
    const cancelled = await create('RENEWAL');
    await prisma.brandSubscription.update({ where: { id: cancelled.agreement.id }, data: { cancelAtPeriodEnd: true, cancelRequestedAt: now } });
    await seed([]);
    await billing.processInvoice(cancelled.invoice.id, now);
    assert.equal((await prisma.brandSubscriptionInvoice.findUniqueOrThrow({ where: { id: cancelled.invoice.id } })).status, 'ACTION_REQUIRED');
    assert((await stats()).every(row => row.method === 'GET'));
    cases.push('fresh debit JOIN refuses a saved card owned by another brand and a cancelled renewal after reference verification; neither submits a charge');
    return { passed: true, cases, debitContextJoinsFor26: debitJoins, invoiceContextJoinsFor26: invoiceJoins, httpCallsFor26Renewals: 78, chargesFor26Renewals: 26, liveProviderOrDeviceVerified: false };
  } finally {
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
