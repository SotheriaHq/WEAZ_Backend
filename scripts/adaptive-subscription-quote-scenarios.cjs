const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const {
  SubscriptionsService,
} = require('../src/subscriptions/subscriptions.service');
const { BrandAccessService } = require('../src/brands/brand-access.service');
const { LEGAL_VERSION } = require('../src/legal/legal.constants');
const {
  subscriptionQuoteApprovalState,
} = require('../src/subscriptions/subscription-quotes');
const {
  securityRequestContext,
  createSecurityLease,
} = require('../src/auth/access/security-request-context');
const { secretDigest } = require('../src/auth/access/security-factor-crypto');
const { withSecurityTransaction } = require('../src/auth/access/transactional-enforcement');
const { PaymentService } = require('../src/payment/payment.service');

// Admission only: actual provider execution has its own protocol/recovery scenarios.
module.exports = async ({ prisma, makeUser, record }) => {
  const originalSecret = process.env.PAYMENT_SAVED_METHODS_SECRET;
  process.env.PAYMENT_SAVED_METHODS_SECRET = randomBytes(32).toString('base64');
  const provider = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(
          'Provider work is forbidden in quote-admission fixtures',
        );
      },
    },
  );
  const payments = Object.create(PaymentService.prototype);
  Object.assign(payments, { prisma });
  const billing = new SubscriptionsService(
    prisma,
    new BrandAccessService(prisma),
    { recordAcceptedDocuments: async () => undefined },
    provider,
    payments,
  );
  const stoppedAfterAdmission = new Error(
    'Fixture stopped before provider preparation',
  );
  billing.executeCheckoutCommand = async () => {
    throw stoppedAfterAdmission;
  };
  const create = async (withCard = false, freeUpgrade = false) => {
    const owner = await makeUser();
    // Current checkout policy admits verified brands only. Set that explicit
    // disposable-fixture prerequisite; never bypass the production guard.
    await prisma.brand.update({ where: { id: owner.brandId }, data: { verificationStatus: 'APPROVED' } });
    const card = withCard
      ? await prisma.savedPaymentMethod.create({
          data: {
            buyerId: owner.actor.id,
            provider: 'PAYSTACK',
            paymentMethod: 'PAYSTACK',
            status: 'ACTIVE',
            last4: '4242',
            expMonth: '12',
            expYear: '2040',
            providerAuthorizationCodeEncrypted:
              payments.encryptSavedPaymentMethodAuthorizationCode(
                'AUTH_disposable_fixture',
              ),
            providerAuthorizationMeta: {
              reusable: true,
              authorizationEmail: owner.user.email,
            },
          },
        })
      : null;
    const agreement = await prisma.brandSubscription.create({
      data: {
        brandId: owner.brandId,
        tierKey: 'THREAD',
        status: 'ACTIVE',
        priceSnapshotNgn: freeUpgrade ? 30000 : 10000,
        currentPeriodStart: new Date(Date.now() - 86400000),
        currentPeriodEnd: new Date(Date.now() + 29 * 86400000),
        billingAnchorDay: 1,
      },
    });
    const quote = await billing.previewForOwner(
      owner.actor.id,
      owner.brandId,
      'ASO_OKE',
    );
    return {
      owner,
      agreement,
      quote,
      input: {
        quoteId: quote.quoteId,
        tierKey: 'ASO_OKE',
        recurringConsent: true,
        legalVersion: LEGAL_VERSION,
        expectedAmountNgn: quote.amountNgn,
        ...(card ? { savedCardId: card.id } : {}),
      },
    };
  };
  const approve = async (row, action = 'checkout') => {
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    const operation = {
      actor: row.owner.actor,
      policy: {
        action: 'brand.billing.change',
        sensitivity: 'CRITICAL_CHANGE',
        scope: 'BRAND_OWNER',
        brandId: row.owner.brandId,
      },
      method: 'POST',
      route: `/brands/:brandId/subscription/${action}`,
      path: `/brands/${row.owner.brandId}/subscription/${action}`,
      body: row.input,
      serverState:
        action === 'checkout'
          ? await subscriptionQuoteApprovalState(
              prisma,
              row.quote.quoteId,
              row.owner.brandId,
              row.owner.actor.id,
              row.input.savedCardId,
            )
          : null,
      requiredAdminPermissions: [],
      operationDigest: `disposable-quote-${randomUUID()}`,
      requestId: randomUUID(),
      proof: `${id}.${secret}`,
    };
    await prisma.securityStepUpChallenge.create({
      data: {
        id,
        userId: row.owner.actor.id,
        sessionId: row.owner.actor.sid,
        authVersion: row.owner.actor.authVersion,
        operationDigest: operation.operationDigest,
        method: operation.method,
        route: operation.route,
        sensitivity: 'CRITICAL_CHANGE',
        nonce: randomBytes(32).toString('base64url'),
        proofHash: secretDigest(secret),
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { id, operation };
  };
  const checkout = (row, approval) =>
    securityRequestContext.run(
      { operation: approval.operation, request: createSecurityLease() },
      () => billing.checkout(row.owner.actor.id, row.owner.brandId, row.input),
    );
  const noEffect = async (row, approval) => {
    assert.equal(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      (
        await prisma.brandSubscriptionQuote.findUniqueOrThrow({
          where: { id: row.quote.quoteId },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      await prisma.brandSubscriptionInvoice.count({
        where: { subscription: { brandId: row.owner.brandId } },
      }),
      0,
    );
  };
  try {
    for (const [key, price] of [
      ['THREAD', 10000],
      ['ASO_OKE', 20000],
      ['ARU', 40000],
    ]) {
      await prisma.subscriptionTier.upsert({
        where: { key },
        create: { key, name: key, monthlyPriceNgn: price },
        update: { monthlyPriceNgn: price },
      });
    }
    const unverified = await create();
    const unverifiedApproval = await approve(unverified);
    await prisma.brand.update({ where: { id: unverified.owner.brandId }, data: { verificationStatus: 'NOT_SUBMITTED' } });
    await assert.rejects(() => checkout(unverified, unverifiedApproval), error => error.getStatus() === 403);
    await noEffect(unverified, unverifiedApproval);
    record('current verified-brand checkout prerequisite blocks an unverified brand without consuming its exact approval or admitting a payment');
    const changedVerification = await create(), changedVerificationApproval = await approve(changedVerification);
    await prisma.brand.update({ where: { id: changedVerification.owner.brandId }, data: { verificationStatus: 'NOT_SUBMITTED' } });
    let mutated = false;
    await assert.rejects(() => securityRequestContext.run({ operation: changedVerificationApproval.operation, request: createSecurityLease() },
      () => withSecurityTransaction(prisma, async () => { mutated = true; })), error => error.getStatus() === 403);
    assert.equal(mutated, false); await noEffect(changedVerification, changedVerificationApproval);
    record('transaction admission rechecks verified-brand status after approval and leaves the proof unspent if verification was withdrawn');
    const held = await create(),
      first = await approve(held),
      duplicate = await approve(held);
    const saved = await prisma.brandSubscriptionQuote.findUniqueOrThrow({
      where: { id: held.quote.quoteId },
    });
    assert.equal(saved.expiresAt - saved.createdAt, 300000);
    // A routine timestamp rewrite is not a material billing change.
    await prisma.brandSubscription.update({
      where: { id: held.agreement.id },
      data: { billingAnchorDay: held.agreement.billingAnchorDay },
    });
    await prisma.subscriptionTier.update({
      where: { key: 'ASO_OKE' },
      data: { monthlyPriceNgn: 30000 },
    });
    await assert.rejects(
      () => checkout(held, first),
      (error) => error === stoppedAfterAdmission,
    );
    const consumed = await prisma.brandSubscriptionQuote.findUniqueOrThrow({
      where: { id: held.quote.quoteId },
    });
    assert(consumed.usedAt && consumed.invoiceId);
    const invoice = await prisma.brandSubscriptionInvoice.findUniqueOrThrow({
      where: { id: consumed.invoiceId },
      include: { subscription: true },
    });
    assert.equal(Number(invoice.amount), held.quote.amountNgn);
    assert.equal(Number(invoice.subscription.priceSnapshotNgn), 20000);
    assert(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).usedAt,
    );
    record(
      'five-minute quoted upgrade pricing and recurring price survive a later tier price change and routine bookkeeping timestamps',
    );
    await assert.rejects(
      () => checkout(held, duplicate),
      (error) => error.getStatus() === 409,
    );
    assert.equal(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: duplicate.id },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      await prisma.brandSubscriptionInvoice.count({
        where: { subscription: { brandId: held.owner.brandId } },
      }),
      1,
    );
    record(
      'a consumed quote cannot create a second invoice even with another verified action approval',
    );
    const alternativeQuote = await billing.previewForOwner(
      held.owner.actor.id,
      held.owner.brandId,
      'ARU',
    );
    const alternative = {
      ...held,
      quote: alternativeQuote,
      input: {
        ...held.input,
        tierKey: 'ARU',
        quoteId: alternativeQuote.quoteId,
        expectedAmountNgn: alternativeQuote.amountNgn,
      },
    };
    const alternativeApproval = await approve(alternative);
    await assert.rejects(
      () => checkout(alternative, alternativeApproval),
      (error) => error.getStatus() === 409,
    );
    assert.equal(
      await prisma.brandSubscriptionInvoice.count({
        where: { subscription: { brandId: held.owner.brandId } },
      }),
      1,
    );
    assert.equal(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: alternativeApproval.id },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      (
        await prisma.brandSubscriptionQuote.findUniqueOrThrow({
          where: { id: alternativeQuote.quoteId },
        })
      ).usedAt,
      null,
    );
    record(
      'an unresolved checkout prevents a second plan payment for the same brand and rolls back the new quote, approval and invoice together',
    );

    const expired = await create(),
      expiredApproval = await approve(expired);
    await prisma.brandSubscriptionQuote.update({
      where: { id: expired.quote.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await assert.rejects(
      () => checkout(expired, expiredApproval),
      (error) => error.getStatus() === 409,
    );
    await noEffect(expired, expiredApproval);
    record(
      'quote expiry after verification rolls back approval consumption and creates no invoice or charge',
    );

    const changed = await create(),
      changedApproval = await approve(changed);
    await prisma.brandSubscription.update({
      where: { id: changed.agreement.id },
      data: { cancelAtPeriodEnd: true },
    });
    await assert.rejects(
      () => checkout(changed, changedApproval),
      (error) => error.getStatus() === 409,
    );
    await noEffect(changed, changedApproval);
    record(
      'material agreement changes invalidate a held quote without spending its action proof',
    );

    const tampered = await create(),
      tamperedApproval = await approve(tampered);
    await prisma.brandSubscriptionQuote.update({
      where: { id: tampered.quote.quoteId },
      data: { amount: { increment: 1 } },
    });
    await assert.rejects(
      () => checkout(tampered, tamperedApproval),
      (error) => error.getStatus() === 409,
    );
    await noEffect(tampered, tamperedApproval);
    record(
      'changing a stored quote after approval is rejected before invoice or provider work',
    );
    const changedCard = await create(true),
      changedCardApproval = await approve(changedCard);
    await prisma.savedPaymentMethod.update({
      where: { id: changedCard.input.savedCardId },
      data: {
        providerAuthorizationMeta: {
          reusable: true,
          authorizationEmail: 'changed@example.invalid',
        },
      },
    });
    await assert.rejects(
      () => checkout(changedCard, changedCardApproval),
      (error) => error.getStatus() === 409,
    );
    await noEffect(changedCard, changedCardApproval);
    record(
      'changing a saved-card identity after quote approval creates no invoice or charge and leaves its proof unspent',
    );

    const downgradeOwner = await makeUser();
    await prisma.brand.update({ where: { id: downgradeOwner.brandId }, data: { verificationStatus: 'APPROVED' } });
    const downgradeAgreement = await prisma.brandSubscription.create({
      data: {
        brandId: downgradeOwner.brandId,
        tierKey: 'ARU',
        status: 'ACTIVE',
        priceSnapshotNgn: 40000,
        currentPeriodStart: new Date(Date.now() - 86400000),
        currentPeriodEnd: new Date(Date.now() + 29 * 86400000),
        billingAnchorDay: 1,
      },
    });
    const downgradeQuote = await billing.previewForOwner(
      downgradeOwner.actor.id,
      downgradeOwner.brandId,
      'THREAD',
    );
    const downgrade = {
      owner: downgradeOwner,
      quote: downgradeQuote,
      input: {
        quoteId: downgradeQuote.quoteId,
        tierKey: 'THREAD',
        recurringConsent: true,
        legalVersion: LEGAL_VERSION,
        expectedAmountNgn: downgradeQuote.amountNgn,
      },
    };
    const downgradeApproval = await approve(downgrade);
    const scheduled = await checkout(downgrade, downgradeApproval);
    assert.equal(scheduled.action, 'SCHEDULED_DOWNGRADE');
    assert.equal(scheduled.subscription.pendingMonthlyPriceNgn, 10000);
    await prisma.subscriptionTier.update({
      where: { key: 'THREAD' },
      data: { monthlyPriceNgn: 17000 },
    });
    await billing.prepareRenewal(
      downgradeAgreement.id,
      downgradeOwner.brandId,
      new Date(+downgradeAgreement.currentPeriodEnd + 1000),
    );
    const renewal = await prisma.brandSubscriptionInvoice.findFirstOrThrow({
      where: {
        previousSubscriptionId: downgradeAgreement.id,
        purpose: 'RENEWAL',
      },
      include: { subscription: true },
    });
    assert.equal(Number(renewal.amount), 10000);
    assert.equal(renewal.subscription.priceSnapshotNgn, 10000);
    assert.equal(
      await prisma.brandSubscriptionCheckoutCommand.count({
        where: {
          invoice: { subscription: { brandId: downgradeOwner.brandId } },
        },
      }),
      0,
    );
    record(
      'a scheduled downgrade renews at its approved price even after the catalogue changes, with no immediate payment-provider work',
    );

    const cancellation = await approve(
      { ...downgrade, input: {} },
      'cancel-renewal',
    );
    await securityRequestContext.run(
      { operation: cancellation.operation, request: createSecurityLease() },
      () =>
        billing.cancelRenewal(downgradeOwner.actor.id, downgradeOwner.brandId),
    );
    const cancelledSchedule = await prisma.brandSubscription.findUniqueOrThrow({
      where: { id: downgradeAgreement.id },
    });
    assert.equal(cancelledSchedule.scheduledTierKey, null);
    assert.equal(cancelledSchedule.scheduledPriceSnapshotNgn, null);
    record(
      'cancelling renewal clears both the scheduled plan and its approved price atomically',
    );

    await prisma.brandSubscriptionQuote.update({
      where: { id: held.quote.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await billing.cleanupExpiredSubscriptionQuotes();
    assert.equal(
      await prisma.brandSubscriptionQuote.count({
        where: { id: expired.quote.quoteId },
      }),
      0,
    );
    assert.equal(
      await prisma.brandSubscriptionQuote.count({
        where: { id: held.quote.quoteId },
      }),
      1,
    );
    record(
      'bounded expired-quote cleanup removes unused offers while retaining the quote linked to an admitted invoice',
    );
    await require('./adaptive-subscription-checkout-scenarios.cjs')({
      prisma,
      record,
      createAdmitted: async (withCard = false, freeUpgrade = false) => {
        const fixture = await create(withCard, freeUpgrade);
        const approval = await approve(fixture);
        await assert.rejects(
          () => checkout(fixture, approval),
          (error) => error === stoppedAfterAdmission,
        );
        const quote = await prisma.brandSubscriptionQuote.findUniqueOrThrow({
          where: { id: fixture.quote.quoteId },
        });
        const command =
          await prisma.brandSubscriptionCheckoutCommand.findFirstOrThrow({
            where: { invoiceId: quote.invoiceId },
          });
        return { ...fixture, command, approval };
      },
    });
  } finally {
    if (originalSecret === undefined)
      delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    else process.env.PAYMENT_SAVED_METHODS_SECRET = originalSecret;
  }
};
