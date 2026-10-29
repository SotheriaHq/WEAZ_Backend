const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AdminPayoutsService } = require('../src/admin/payouts/admin-payouts.service');
const { PayoutService } = require('../src/payout/payout.service');
const { FinancialDocumentsService } = require('../src/finance/financial-documents.service');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function arrived(gate, running) {
  let timer;
  try {
    await Promise.race([gate.promise, running.then(() => { throw Error('Transfer finished before its HTTP gate'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Transfer did not reach HTTP gate')), 10000); })]);
  } finally { clearTimeout(timer); }
}

module.exports = async function verifyPayoutTransfers({ prisma, ledger, balance, paid, adminId }) {
  const cases = [], transfers = new Map(), gates = new Map(), modes = new Map(), posts = new Map();
  const actualFetch = global.fetch;
  const savedEnabled = process.env.PAYSTACK_PAYOUT_TRANSFERS_ENABLED;
  process.env.PAYSTACK_PAYOUT_TRANSFERS_ENABLED = 'true';
  let unexpectedRequests = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      assert.match(req.headers.authorization ?? '', /^Bearer sk_test_fixture_/);
      const url = new URL(req.url, 'http://127.0.0.1');
      let transfer, operation;
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (url.pathname === '/transfer') {
          operation = 'INITIATE';
          transfer = transfers.get(body.reference) ?? { ...body, transfer_code: `TRF_${randomUUID()}`, id: transfers.size + 8000, status: 'pending' };
          transfers.set(body.reference, transfer);
        } else if (url.pathname === '/transfer/finalize_transfer') {
          operation = 'FINALIZE';
          assert.equal(body.otp, '123456');
          transfer = [...transfers.values()].find(item => item.transfer_code === body.transfer_code);
          assert(transfer); transfer.status = 'pending';
        } else throw Error('Unexpected payout POST');
        posts.set(`${operation}:${transfer.reference}`, (posts.get(`${operation}:${transfer.reference}`) ?? 0) + 1);
      } else if (req.method === 'GET') {
        operation = 'LOOKUP';
        transfer = url.pathname.startsWith('/transfer/verify/')
          ? transfers.get(decodeURIComponent(url.pathname.slice('/transfer/verify/'.length)))
          : [...transfers.values()].find(item => item.transfer_code === decodeURIComponent(url.pathname.slice('/transfer/'.length)));
        if (!transfer) return send(404, { status: false, message: 'Transfer not found' });
      } else throw Error('Unexpected payout request');
      const mode = modes.get(transfer.reference);
      const view = { ...transfer, recipient: { recipient_code: transfer.recipient } };
      if (mode === 'otp') view.status = transfer.status = 'otp';
      if (mode === 'failed') view.status = transfer.status = 'failed';
      if (mode === 'drop' && operation !== 'LOOKUP') { req.socket.destroy(); return; }
      if (mode === 'wrong-amount') view.amount += 1;
      if (mode === 'wrong-reference') view.reference = 'foreign-transfer';
      if (mode === 'wrong-currency') view.currency = 'USD';
      const gate = gates.get(`${operation}:${transfer.reference}`);
      if (gate) { gates.delete(`${operation}:${transfer.reference}`); gate.ready.resolve(); await gate.release.promise; }
      send(200, { status: true, data: view });
    } catch {
      unexpectedRequests++;
      if (!res.headersSent) send(500, { status: false, message: 'Synthetic transfer contract failure' });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  global.fetch = (input, init) => {
    const url = new URL(String(input));
    // This fixture is incapable of contacting a real provider.
    assert.equal(url.origin, 'https://api.paystack.co');
    assert(url.pathname.startsWith('/transfer'));
    return actualFetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, init);
  };
  const service = new AdminPayoutsService(prisma, ledger, new FinancialDocumentsService(prisma), {});
  const payouts = new PayoutService(prisma);
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'user-agent': 'synthetic-payout-fixture' } };
  const initiate = id => service.initiateTransfer(id, adminId, 'SuperAdmin', req);
  const finalize = id => service.finalizeTransferOtp(id, '123456', adminId, 'SuperAdmin', req);
  const lookup = id => service.getProviderStatus(id, adminId, 'SuperAdmin');
  const row = id => prisma.payout.findUniqueOrThrow({ where: { id } });
  const gate = (operation, reference) => { const value = { ready: deferred(), release: deferred() }; gates.set(`${operation}:${reference}`, value); return value; };
  const make = async () => {
    const ownerId = randomUUID(), brandId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, username: `payout-${ownerId}`, email: `${ownerId}@example.invalid`, status: 'ACTIVE' } });
    await prisma.brand.create({ data: { id: brandId, ownerId, name: 'Payout fixture', verificationStatus: 'APPROVED' } });
    await prisma.storePaymentAccount.create({ data: { brandId, status: 'ACTIVE', transferRecipientCode: `RCP_${randomUUID()}`, transferRecipientActive: true } });
    await paid({ brandId, amount: 100000 });
    const payout = await prisma.$transaction(tx => payouts.writePayoutRow(tx, brandId, 20000), { timeout: 20000 });
    await prisma.payout.update({ where: { id: payout.id }, data: { status: 'APPROVED' } });
    return { id: payout.id, brandId, reference: `wiez-payout-${payout.id}` };
  };
  const webhook = async (item, status) => {
    const transfer = transfers.get(item.reference); assert(transfer);
    transfer.status = status;
    await service.processQueuedPaystackWebhook({ payoutId: item.id, providerEventKey: `synthetic:${randomUUID()}`, providerEventType: `transfer.${status}`, payload: { data: { ...transfer, recipient: { recipient_code: transfer.recipient } } } });
  };
  const active = [];
  try {
    const item = await make(), blocked = gate('INITIATE', item.reference);
    const first = initiate(item.id); active.push(first); first.catch(() => {});
    await arrived(blocked.ready, first);
    try {
      const competitors = await Promise.allSettled(Array.from({ length: 24 }, () => initiate(item.id)));
      assert(competitors.every(value => value.status === 'rejected' && value.reason.status === 409));
      // Real lock acquisition succeeds while the HTTP response remains gated.
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1000ms'");
        await balance.lockBrand(tx, item.brandId);
        await tx.$queryRaw`SELECT "_id" AS id FROM "Payout" WHERE "_id"=${item.id}::uuid FOR UPDATE`;
      });
      assert.equal(posts.get(`INITIATE:${item.reference}`), 1);
    } finally { blocked.release.resolve(); await first; }
    assert.equal((await row(item.id)).transferLeaseToken, null);
    await assert.rejects(service.updateStatus(item.id, { status: 'FAILED' }, adminId, 'SuperAdmin', req));
    cases.push('25 competing initiations send one HTTP POST; real brand and payout locks can be acquired while the provider response is paused, proving no database transaction spans HTTP');

    const otp = await make(); modes.set(otp.reference, 'otp'); await initiate(otp.id); modes.delete(otp.reference);
    const finalGate = gate('FINALIZE', otp.reference), sending = finalize(otp.id); active.push(sending); sending.catch(() => {});
    await arrived(finalGate.ready, sending);
    try {
      const competing = await Promise.allSettled([...Array.from({ length: 20 }, () => finalize(otp.id)), lookup(otp.id), service.updateStatus(otp.id, { status: 'FAILED' }, adminId, 'SuperAdmin', req)]);
      assert(competing.every(value => value.status === 'rejected'));
      await webhook(otp, 'success');
      assert.equal((await row(otp.id)).status, 'PAID');
    } finally { finalGate.release.resolve(); await sending; }
    assert.equal((await row(otp.id)).status, 'PAID');
    assert.equal(posts.get(`FINALIZE:${otp.reference}`), 1);
    assert.equal(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:payout:${otp.id}:paid` } }), 1);
    assert.equal(await prisma.financialDocument.count({ where: { payoutId: otp.id } }), 2);
    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: otp.id } });
    assert(!JSON.stringify(audit).includes('123456'));
    cases.push('concurrent OTP finalization sends once, refuses manual cancellation and concurrent lookup during the send; a success webhook wins over the late pending response, with one payout journal and two financial documents, and no persisted OTP');

    for (const mode of ['drop', 'wrong-amount', 'wrong-reference', 'wrong-currency']) {
      const unknown = await make(); modes.set(unknown.reference, mode);
      await assert.rejects(initiate(unknown.id));
      const saved = await row(unknown.id);
      assert.equal(saved.status, 'PROCESSING'); assert.equal(saved.providerTransferStatus, 'OUTCOME_UNKNOWN');
      assert.equal(saved.providerTransferReference, unknown.reference); assert.equal(saved.transferLeaseToken, null);
      await assert.rejects(initiate(unknown.id));
      modes.delete(unknown.reference); await lookup(unknown.id);
      assert.equal(posts.get(`INITIATE:${unknown.reference}`), 1);
      assert.equal((await row(unknown.id)).providerTransferCode, transfers.get(unknown.reference).transfer_code);
      cases.push(`a ${mode} submission response retains its reservation and original reference, requires provider verification and cannot produce a second transfer`);
    }

    const debt = await make(), held = deferred(), release = deferred();
    const raising = prisma.$transaction(async tx => {
      await balance.raiseAdjustment(tx, { brandId: debt.brandId, type: 'MANUAL_DEBIT', amount: 10000, reason: 'Synthetic current debt', createdById: adminId, sourceKey: `payout-proof:${randomUUID()}` });
      held.resolve(); await release.promise;
    }, { timeout: 20000 }); active.push(raising); raising.catch(() => {});
    await arrived(held, raising);
    const waiting = initiate(debt.id); active.push(waiting); waiting.catch(() => {});
    try {
      for (let i = 0;; i++) {
        const blocked = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM "Brand" b%FOR NO KEY UPDATE OF b%'`;
        if (blocked.length) break;
        assert(i < 200, 'Payout did not wait on the real brand lock'); await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { release.resolve(); await raising; }
    await assert.rejects(waiting, error => error.response?.code === 'PAYOUT_FUNDS_CHANGED');
    assert.equal(posts.get(`INITIATE:${debt.reference}`) ?? 0, 0);
    cases.push('a payout actually waiting behind a committed debt adjustment rechecks the current reserved position and refuses transfer without any provider call');

    const otpDebt = await make(); modes.set(otpDebt.reference, 'otp'); await initiate(otpDebt.id); modes.delete(otpDebt.reference);
    await prisma.$transaction(tx => balance.raiseAdjustment(tx, { brandId: otpDebt.brandId, type: 'MANUAL_DEBIT', amount: 10000, reason: 'Synthetic debt before OTP', createdById: adminId }));
    await assert.rejects(finalize(otpDebt.id), error => error.response?.code === 'PAYOUT_FUNDS_CHANGED');
    assert.equal(posts.get(`FINALIZE:${otpDebt.reference}`) ?? 0, 0);
    cases.push('OTP finalization rechecks current earnings and source reservations instead of trusting the earlier initiation');

    const late = await make(); await initiate(late.id);
    const lookupGate = gate('LOOKUP', late.reference), polling = lookup(late.id); active.push(polling); polling.catch(() => {});
    await arrived(lookupGate.ready, polling);
    try { await webhook(late, 'success'); } finally { lookupGate.release.resolve(); await polling; }
    await webhook(late, 'pending'); await webhook(late, 'failed');
    assert.equal((await row(late.id)).status, 'PAID');
    await webhook(late, 'reversed'); await webhook(late, 'success');
    assert.equal((await row(late.id)).status, 'RECONCILIATION_REVIEW');
    assert.equal(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `ledger:payout:${late.id}:paid` } }), 1);
    cases.push('a late polling owner and out-of-order pending/failed webhooks cannot regress PAID; reversal stays in reconciliation and a later success cannot post a second payout');

    const retry = await make(); modes.set(retry.reference, 'failed'); await initiate(retry.id); modes.delete(retry.reference);
    await initiate(retry.id);
    assert.equal(posts.get(`INITIATE:${retry.reference}`), 2);
    assert.equal((await row(retry.id)).providerTransferReference, retry.reference);
    assert.equal([...transfers.values()].filter(item => item.reference === retry.reference).length, 1);
    cases.push('an explicitly retried provider-confirmed failure preserves the original Paystack reference and recipient instead of minting another identity');

    const claim = await make();
    const people = [adminId, randomUUID()];
    await prisma.user.create({ data: { id: people[1], username: `admin-${people[1]}`, email: `${people[1]}@example.invalid` } });
    const claims = await Promise.allSettled(people.map(id => service.claim(claim.id, id, 'Admin', req)));
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(claims.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
    cases.push('opposing administrative claims read the locked current owner and exactly one admin wins');
    assert.equal(unexpectedRequests, 0);
    return { cases, payoutProof: { cases: cases.length, transferPosts: [...posts.values()].reduce((a,b) => a+b, 0), providerTransfers: transfers.size, liveProviderCalls: 0 } };
  } finally {
    for (const item of gates.values()) item.release.resolve();
    await Promise.allSettled(active);
    global.fetch = actualFetch;
    if (savedEnabled === undefined) delete process.env.PAYSTACK_PAYOUT_TRANSFERS_ENABLED;
    else process.env.PAYSTACK_PAYOUT_TRANSFERS_ENABLED = savedEnabled;
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  }
};
