const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const {
  SubscriptionsService,
} = require('../src/subscriptions/subscriptions.service');
const {
  SubscriptionPaystackService,
} = require('../src/subscriptions/subscription-paystack.service');
const { BrandAccessService } = require('../src/brands/brand-access.service');

// Real HTTP and real PostgreSQL, using only the parent harness's disposable database.
module.exports = async ({ prisma, createAdmitted, record }) => {
  const [db] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test(db.name));
  const saved = {
    mode: process.env.PAYMENTS_MODE,
    secret: process.env.PAYSTACK_SECRET_KEY,
  };
  process.env.PAYMENTS_MODE = 'live';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_disposable_http_fixture';
  const transactions = new Map(),
    calls = [],
    controls = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const path = new URL(req.url, 'http://localhost').pathname;
    const reference =
      body?.reference ?? decodeURIComponent(path.split('/').at(-1));
    calls.push({ method: req.method, path, reference });
    res.setHeader('content-type', 'application/json');
    const control = controls.get(reference);
    if (req.method === 'GET') {
      if (control?.beforeVerify) await control.beforeVerify();
      const row = transactions.get(reference);
      res.writeHead(row ? 200 : 404);
      res.end(
        JSON.stringify(
          row
            ? { status: true, data: row }
            : { status: false, message: 'Transaction not found' },
        ),
      );
      return;
    }
    if (control?.beforePost) await control.beforePost();
    const charge = path.endsWith('charge_authorization');
    const row = {
      reference,
      status: charge ? 'success' : 'pending',
      amount: body.amount,
      currency: body.currency,
      id: randomUUID(),
      paid_at: new Date().toISOString(),
      customer: { email: body.email },
    };
    if (control?.loseResponse) {
      if (control.recordCapture) transactions.set(reference, row);
      req.socket.destroy();
      return;
    }
    transactions.set(reference, row);
    res.end(
      JSON.stringify({
        status: true,
        data: charge
          ? row
          : {
              reference,
              authorization_url: `https://checkout.paystack.com/disposable-${reference}`,
              access_code: 'fixture_only',
            },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const provider = new SubscriptionPaystackService(
    `http://127.0.0.1:${server.address().port}`,
  );
  const billing = new SubscriptionsService(
    prisma,
    new BrandAccessService(prisma),
    {},
    provider,
  );
  const commands = billing.checkoutCommands();
  const posts = (reference) =>
    calls.filter((row) => row.method === 'POST' && row.reference === reference);
  const row = (id) =>
    prisma.brandSubscriptionCheckoutCommand.findUniqueOrThrow({
      where: { id },
    });
  const expireLease = (id) =>
    prisma.brandSubscriptionCheckoutCommand.update({
      where: { id },
      data: {
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
  try {
    const free = await createAdmitted(false, true);
    const requestsBefore = calls.length;
    const freeResult = await commands.execute(free.command.id);
    await commands.execute(free.command.id);
    assert.equal(freeResult.amountNgn, 0);
    assert.equal((await row(free.command.id)).state, 'SUCCEEDED');
    assert.equal(
      await prisma.brandSubscriptionPaymentCapture.count({
        where: { invoiceId: free.command.invoiceId },
      }),
      1,
    );
    assert.equal(calls.length, requestsBefore);
    record(
      'a zero-charge upgrade recovers exactly once into its entitlement with no payment-provider HTTP',
    );

    const hosted = await createAdmitted();
    assert(!hosted.command.commandCiphertext.includes(hosted.owner.user.email));
    // The user signs out after the command has committed. Recovery must record the already approved instruction.
    await prisma.refreshToken.delete({ where: { id: hosted.owner.actor.sid } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => commands.execute(hosted.command.id)),
    );
    assert.equal(posts(hosted.command.reference).length, 1);
    assert(
      results.some((item) =>
        item.authorizationUrl?.startsWith('https://checkout.paystack.com/'),
      ),
    );
    await commands.execute(hosted.command.id);
    assert.equal(posts(hosted.command.reference).length, 1);
    assert.equal((await row(hosted.command.id)).state, 'WAITING');
    record(
      'eight concurrent hosted checkouts dispatch once; the committed encrypted instruction survives logout and repeated verification preserves the original checkout URL',
    );

    const recovered = await createAdmitted();
    await expireLease(recovered.command.id);
    await commands.recoverDue();
    assert.equal(posts(recovered.command.reference).length, 1);
    record(
      'a READY checkout left by a stopped worker is recovered from the database using the original amount and reference',
    );
    const immediate = await createAdmitted(true);
    const immediateResult = await commands.execute(immediate.command.id);
    assert.equal(immediateResult.status, 'PAID');
    assert.equal((await row(immediate.command.id)).state, 'SUCCEEDED');
    assert.equal(posts(immediate.command.reference).length, 1);
    record(
      'a successful saved-card checkout verifies and applies its entitlement immediately instead of waiting for the recovery cron',
    );

    const unknown = await createAdmitted(true);
    controls.set(unknown.command.reference, {
      loseResponse: true,
      recordCapture: false,
    });
    await commands.execute(unknown.command.id);
    assert.equal((await row(unknown.command.id)).state, 'WAITING');
    await commands.execute(unknown.command.id);
    assert.equal((await row(unknown.command.id)).state, 'REVIEW');
    await commands.execute(unknown.command.id);
    assert.equal(posts(unknown.command.reference).length, 1);
    record(
      'a lost saved-card response followed by provider NOT_FOUND enters review and never repeats the debit',
    );

    const captured = await createAdmitted(true);
    controls.set(captured.command.reference, {
      loseResponse: true,
      recordCapture: true,
    });
    await commands.execute(captured.command.id);
    await commands.execute(captured.command.id);
    assert.equal((await row(captured.command.id)).state, 'SUCCEEDED');
    assert.equal(posts(captured.command.reference).length, 1);
    assert.equal(
      await prisma.brandSubscriptionPaymentCapture.count({
        where: { invoiceId: captured.command.invoiceId, status: 'APPLIED' },
      }),
      1,
    );
    record(
      'a captured payment with a lost response is verified once into its invoice and entitlement without another debit',
    );

    const beforeHttp = await createAdmitted(true);
    await prisma.brandSubscriptionCheckoutCommand.update({
      where: { id: beforeHttp.command.id },
      data: { state: 'DISPATCHED', dispatchedAt: new Date() },
    });
    await expireLease(beforeHttp.command.id);
    await commands.execute(beforeHttp.command.id);
    assert.equal((await row(beforeHttp.command.id)).state, 'REVIEW');
    assert.equal(posts(beforeHttp.command.reference).length, 0);
    record(
      'a crash between the committed dispatch marker and HTTP is treated as uncertain rather than replayed',
    );

    const fenced = await createAdmitted();
    let reached;
    const reachedPost = new Promise((resolve) => {
      reached = resolve;
    });
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    controls.set(fenced.command.reference, {
      beforePost: async () => {
        reached();
        await wait;
      },
    });
    const running = commands.execute(fenced.command.id);
    await reachedPost;
    await expireLease(fenced.command.id);
    await commands.execute(fenced.command.id);
    assert.equal((await row(fenced.command.id)).state, 'REVIEW');
    release();
    await running;
    assert.equal((await row(fenced.command.id)).state, 'REVIEW');
    assert.equal(
      (
        await prisma.brandSubscriptionInvoice.findUniqueOrThrow({
          where: { id: fenced.command.invoiceId },
        })
      ).authorizationUrl,
      null,
    );
    assert.equal(posts(fenced.command.reference).length, 1);
    record(
      'a late provider response from an expired worker cannot overwrite its replacement worker or revive an uncertain checkout URL',
    );

    const removed = await createAdmitted(true);
    await prisma.savedPaymentMethod.update({
      where: { id: removed.input.savedCardId },
      data: { status: 'DISABLED' },
    });
    await commands.execute(removed.command.id);
    assert.equal((await row(removed.command.id)).state, 'FAILED');
    assert.equal(posts(removed.command.reference).length, 0);
    record(
      'a saved card disabled after approval but before dispatch cannot be charged',
    );

    const copied = await createAdmitted();
    await prisma.brandSubscriptionCheckoutCommand.update({
      where: { id: copied.command.id },
      data: { commandCiphertext: hosted.command.commandCiphertext },
    });
    await commands.execute(copied.command.id);
    assert.equal(posts(copied.command.reference).length, 0);
    assert.equal((await row(copied.command.id)).state, 'REVIEW');
    record(
      'copying encrypted checkout instructions between invoices fails authenticated decryption before any provider call',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of [
      ['PAYMENTS_MODE', saved.mode],
      ['PAYSTACK_SECRET_KEY', saved.secret],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};
