const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const {
  SubscriptionsService,
} = require('../src/subscriptions/subscriptions.service');
const { BrandAccessService } = require('../src/brands/brand-access.service');
const { LEGAL_VERSION } = require('../src/legal/legal.constants');
const {
  securityRequestContext,
  createSecurityLease,
} = require('../src/auth/access/security-request-context');
const { secretDigest } = require('../src/auth/access/security-factor-crypto');
const {
  savedPaymentMethodApprovalState,
  savedPaymentMethodVersion,
} = require('../src/payment/saved-payment-method-version');

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  const originalSecret = process.env.PAYMENT_SAVED_METHODS_SECRET;
  process.env.PAYMENT_SAVED_METHODS_SECRET = randomBytes(32).toString('base64');
  const provider = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(
          'No provider calls are permitted in subscription-instruction scenarios',
        );
      },
    },
  );
  const authority = async (owner, action, body = {}) => {
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    const operation = {
      actor: owner.actor,
      policy: {
        action: 'brand.billing.change',
        sensitivity: 'CRITICAL_CHANGE',
        scope: 'BRAND_OWNER',
        brandId: owner.brandId,
      },
      method: 'POST',
      route: `/brands/:brandId/subscription/${action}`,
      path: `/brands/${owner.brandId}/subscription/${action}`,
      body,
      serverState:
        action === 'payment-method' &&
        (await prisma.savedPaymentMethod.findFirst({
          where: {
            id: body.savedCardId,
            buyerId: owner.actor.id,
            status: 'ACTIVE',
          },
          select: { id: true },
        }))
          ? await savedPaymentMethodApprovalState(
              prisma,
              owner.actor.id,
              body.savedCardId,
            )
          : null,
      requiredAdminPermissions: [],
      operationDigest: `disposable-billing-${randomUUID()}`,
      requestId: randomUUID(),
      proof: `${id}.${secret}`,
    };
    await prisma.securityStepUpChallenge.create({
      data: {
        id,
        userId: owner.actor.id,
        sessionId: owner.actor.sid,
        authVersion: owner.actor.authVersion,
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
    return { operation, id };
  };
  const execute = (operation, work) =>
    securityRequestContext.run(
      { operation, request: createSecurityLease() },
      work,
    );
  const createAgreement = (owner) =>
    prisma.brandSubscription.create({
      data: {
        brandId: owner.brandId,
        tierKey: 'THREAD',
        priceSnapshotNgn: 10000,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        billingAnchorDay: 1,
        providerCustomerEmail: owner.user.email,
      },
    });
  const service = (payments) =>
    new SubscriptionsService(
      prisma,
      new BrandAccessService(prisma),
      { recordAcceptedDocuments: async () => undefined },
      provider,
      payments,
    );
  try {
    await prisma.subscriptionTier.upsert({
      where: { key: 'THREAD' },
      create: { key: 'THREAD', name: 'Thread', monthlyPriceNgn: 10000 },
      update: {},
    });
    const owner = await makeUser(),
      agreement = await createAgreement(owner),
      billing = service();
    await assert.rejects(
      () => billing.cancelRenewal(owner.actor.id, owner.brandId),
      (error) => error.getStatus() === 403,
    );
    assert.equal(
      (
        await prisma.brandSubscription.findUniqueOrThrow({
          where: { id: agreement.id },
        })
      ).cancelAtPeriodEnd,
      false,
    );
    record(
      'subscription renewal cancellation without live action authority leaves the agreement unchanged',
    );
    const approval = await authority(owner, 'cancel-renewal');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        execute({ ...approval.operation, requestId: randomUUID() }, () =>
          billing.cancelRenewal(owner.actor.id, owner.brandId),
        ),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert(
      results
        .filter((result) => result.status === 'rejected')
        .every((result) => [409, 428].includes(result.reason.getStatus())),
    );
    assert.equal(
      (
        await prisma.brandSubscription.findUniqueOrThrow({
          where: { id: agreement.id },
        })
      ).cancelAtPeriodEnd,
      true,
    );
    assert.equal(
      await prisma.emailOutbox.count({
        where: { recipientUserId: owner.actor.id },
      }),
      1,
    );
    assert(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).usedAt,
    );
    record(
      'one cancellation approval admits one mutation and one transactional notice across eight concurrent requests',
    );

    const revoked = await makeUser(),
      revokedAgreement = await createAgreement(revoked);
    const revokedApproval = await authority(revoked, 'cancel-renewal');
    await tokenService.revokeCurrentSession(
      revoked.actor.id,
      revoked.actor.sid,
    );
    await assert.rejects(
      () =>
        execute(revokedApproval.operation, () =>
          billing.cancelRenewal(revoked.actor.id, revoked.brandId),
        ),
      (error) => error.getStatus() === 401,
    );
    assert.equal(
      (
        await prisma.brandSubscription.findUniqueOrThrow({
          where: { id: revokedAgreement.id },
        })
      ).cancelAtPeriodEnd,
      false,
    );
    record(
      'revoking the initiating session prevents subscription cancellation despite an earlier verified approval',
    );

    const cardOwner = await makeUser(),
      cardAgreement = await createAgreement(cardOwner),
      outsider = await makeUser();
    const foreignCard = await prisma.savedPaymentMethod.create({
      data: {
        buyerId: outsider.actor.id,
        provider: 'PAYSTACK',
        paymentMethod: 'PAYSTACK',
        last4: '4242',
      },
    });
    const payments = {
      getSubscriptionSavedCard: async (_actor, id) => ({
        savedPaymentMethodId: id,
        authorizationCode: 'AUTH_disposable_fixture',
        authorizationEmail: cardOwner.user.email,
        credentialVersion: savedPaymentMethodVersion(
          await prisma.savedPaymentMethod.findUniqueOrThrow({ where: { id } }),
        ),
      }),
    };
    const cardBilling = service(payments),
      wrongInput = {
        savedCardId: foreignCard.id,
        recurringConsent: true,
        legalVersion: LEGAL_VERSION,
      };
    const wrongApproval = await authority(
      cardOwner,
      'payment-method',
      wrongInput,
    );
    await assert.rejects(
      () =>
        execute(wrongApproval.operation, () =>
          cardBilling.changePaymentMethod(
            cardOwner.actor.id,
            cardOwner.brandId,
            wrongInput,
          ),
        ),
      (error) => error.getStatus() === 409,
    );
    assert.equal(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: wrongApproval.id },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      (
        await prisma.brandSubscription.findUniqueOrThrow({
          where: { id: cardAgreement.id },
        })
      ).savedPaymentMethodId,
      null,
    );
    record(
      'a renewal-card ownership conflict rolls back both the approval and subscription change',
    );
    const ownCard = await prisma.savedPaymentMethod.create({
      data: {
        buyerId: cardOwner.actor.id,
        provider: 'PAYSTACK',
        paymentMethod: 'PAYSTACK',
        last4: '1111',
      },
    });
    const input = { ...wrongInput, savedCardId: ownCard.id },
      ownApproval = await authority(cardOwner, 'payment-method', input);
    await execute(ownApproval.operation, () =>
      cardBilling.changePaymentMethod(
        cardOwner.actor.id,
        cardOwner.brandId,
        input,
      ),
    );
    const changed = await prisma.brandSubscription.findUniqueOrThrow({
      where: { id: cardAgreement.id },
    });
    assert.equal(changed.savedPaymentMethodId, ownCard.id);
    assert(
      changed.providerAuthorizationCode &&
        !changed.providerAuthorizationCode.includes('AUTH_disposable_fixture'),
    );
    assert(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: ownApproval.id },
        })
      ).usedAt,
    );
    record(
      'renewal-card replacement and its one-use approval commit together with brand-bound encrypted authorization',
    );
    const staleCardApproval = await authority(
      cardOwner,
      'payment-method',
      input,
    );
    await prisma.savedPaymentMethod.update({
      where: { id: ownCard.id },
      data: {
        providerAuthorizationMeta: {
          reusable: true,
          authorizationEmail: 'changed@example.invalid',
        },
      },
    });
    await assert.rejects(
      () =>
        execute(staleCardApproval.operation, () =>
          cardBilling.changePaymentMethod(
            cardOwner.actor.id,
            cardOwner.brandId,
            input,
          ),
        ),
      (error) => error.getStatus() === 409,
    );
    assert.equal(
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: staleCardApproval.id },
        })
      ).usedAt,
      null,
    );
    assert.equal(
      (
        await prisma.brandSubscription.findUniqueOrThrow({
          where: { id: cardAgreement.id },
        })
      ).providerAuthorizationCode,
      changed.providerAuthorizationCode,
    );
    record(
      'changing a renewal-card credential identity after verification invalidates approval and leaves the existing agreement untouched',
    );
  } finally {
    if (originalSecret === undefined)
      delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    else process.env.PAYMENT_SAVED_METHODS_SECRET = originalSecret;
  }
};
