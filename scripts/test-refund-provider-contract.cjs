const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Prisma } = require('@prisma/client');
require('ts-node').register({ transpileOnly: true });
const { RefundProviderClient } = require('../src/finance/refund-provider.client');

const capture = { reference: 'charge-reference', provider: 'PAYSTACK', providerMode: 'test', providerTransactionId: '12345', amount: new Prisma.Decimal(100), currency: 'NGN', settlementAmount: null, settlementCurrency: null };
const target = { amount: new Prisma.Decimal(10), currency: 'NGN' };
const marker = 'WIEZ standard refund 90000000-0000-4000-8000-000000000001';
const refund = (overrides = {}) => ({ id: 7, transaction: 12345, currency: 'NGN', amount: 1000, status: 'processed', merchant_note: marker, ...overrides });
async function fixture(run, handler) {
  const previous = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_refund_contract_fixture';
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(url);
    assert.equal(req.headers.authorization, 'Bearer sk_test_refund_contract_fixture');
    const reply = handler(url);
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(new RefundProviderClient({ PAYSTACK: `http://127.0.0.1:${server.address().port}` }), requests); }
  finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previous;
  }
}

test('transaction reference cannot override a contradictory provider transaction id', () => {
  const client = new RefundProviderClient();
  assert.equal(client.matches(capture, target, { amount: new Prisma.Decimal(10), currency: 'NGN', transactionReference: capture.reference, transactionId: '999' }), false);
  assert.equal(client.matches(capture, target, { amount: new Prisma.Decimal(10), currency: 'NGN', transactionReference: 'wrong', transactionId: '12345' }), false);
});

test('fetch cannot rewrite a different refund id into the requested id', async () => {
  await fixture(async client => {
    await assert.rejects(() => client.fetch(capture, '7'));
  }, () => ({ body: { status: true, data: refund({ id: 8 }) } }));
});

test('a missing provider refund id is not invented by the fetch adapter', async () => {
  await fixture(async client => { await assert.rejects(() => client.fetch(capture, '7')); },
    () => ({ body: { status: true, data: refund({ id: undefined }) } }));
});

test('uncertain submission lookup uses documented transaction filter and complete pagination', async () => {
  await fixture(async (client, requests) => {
    const found = await client.findByNote(capture, marker);
    assert.equal(found.length, 1); assert.equal(found[0].id, '7');
    assert.equal(requests.length, 2);
    for (const url of requests) { assert.equal(url.searchParams.get('transaction'), '12345'); assert.equal(url.searchParams.get('reference'), null); }
  }, url => ({ body: { status: true, data: url.searchParams.get('page') === '2' ? [refund()] : [refund({ id: 6, merchant_note: 'another refund' })], meta: { page: Number(url.searchParams.get('page')), pageCount: 2 } } }));
});

test('lookalike merchant-note prefixes/suffixes do not identify a refund', async () => {
  await fixture(async client => { assert.deepEqual(await client.findByNote(capture, marker), []); },
    () => ({ body: { status: true, data: [refund({ merchant_note: `${marker}-wrong` }), refund({ id: 8, merchant_note: `prefix ${marker}` })] } }));
});

test('incomplete provider pagination is unknown, never a partial successful lookup', async () => {
  await fixture(async client => { assert.equal(await client.findByNote(capture, marker), null); },
    url => url.searchParams.get('page') === '2' ? { status: 503, body: { status: false } } : { body: { status: true, data: [refund()], meta: { page: 1, pageCount: 2 } } });
});

test('provider search has a strict page budget and requires a transaction identity', async () => {
  await fixture(async (client, requests) => {
    assert.equal(await client.findByNote(capture, marker), null);
    assert(requests.length <= 5);
    const previous = requests.length;
    assert.equal(await client.findByNote({ ...capture, providerTransactionId: null }, marker), null);
    assert.equal(requests.length, previous);
  }, url => ({ body: { status: true, data: [refund()], meta: { page: Number(url.searchParams.get('page')), pageCount: 1000 } } }));
});
