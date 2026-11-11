// Synthetic provider + the caller's disposable PostgreSQL database only.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  StorePaymentAccountSynchronizer,
  StoreBankIdentity,
} = require('../src/store/store-payment-account-sync');
const {
  createSecurityLease,
  securityRequestContext,
} = require('../src/auth/access/security-request-context');
const { secretDigest } = require('../src/auth/access/security-factor-crypto');

module.exports = async ({ prisma, makeUser, tokenService, record }) => {
  const actors = new Map();
  const owner = async () => {
    const value = await makeUser();
    actors.set(value.actor.id, value.actor);
    return value;
  };
  const identity = new StoreBankIdentity(randomBytes(32).toString('base64'));
  const {
    preparePayoutBankClaims,
  } = require('./prepare-payout-bank-claims.cjs');
  const old = await owner();
  await prisma.storePaymentAccount.create({
    data: {
      brandId: old.brandId,
      bankCode: '058',
      accountNumberEncrypted: 'fixture-before-cutover',
    },
  });
  assert.equal(
    (await preparePayoutBankClaims(prisma, identity, () => '1111111111'))
      .prepared,
    1,
  );
  const duplicate = await owner();
  const duplicateAccount = await prisma.storePaymentAccount.create({
    data: {
      brandId: duplicate.brandId,
      bankCode: '058',
      accountNumberEncrypted: 'fixture-duplicate',
    },
  });
  await assert.rejects(
    () => preparePayoutBankClaims(prisma, identity, () => '1111111111'),
    /ownership conflict/,
  );
  assert.equal(
    (
      await prisma.storePayoutIdentityState.findUniqueOrThrow({
        where: { id: 'payout-bank-v1' },
      })
    ).ready,
    false,
  );
  await prisma.storePaymentAccount.delete({
    where: { id: duplicateAccount.id },
  });
  await preparePayoutBankClaims(prisma, identity, () => '1111111111');
  record(
    'existing bank accounts are prepared resumably and duplicate ownership leaves the release gate closed',
  );
  const encryptionKey = randomBytes(32),
    insideTransaction = new AsyncLocalStorage();
  const wrapped = new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction')
        return (work, options) =>
          target.$transaction(
            (tx) => insideTransaction.run(true, () => work(tx)),
            options,
          );
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const calls = [],
    subaccounts = [],
    recipients = new Map();
  let lostSubaccount = false,
    lostRecipient = false,
    beforeResponse;
  const provider = async (path, options = {}) => {
    assert.equal(
      insideTransaction.getStore(),
      undefined,
      'Provider HTTP must not inherit a database transaction',
    );
    calls.push({ path, method: options.method || 'GET' });
    let result;
    const body = options.bodyJson;
    if (path.startsWith('/bank/resolve')) {
      const url = new URL(path, 'https://example.invalid');
      result = {
        account_number: url.searchParams.get('account_number'),
        account_name: 'Fixture account',
        bank_id: 9,
      };
    } else if (path.startsWith('/subaccount?')) {
      result = subaccounts.slice();
    } else if (path === '/subaccount' && options.method === 'POST') {
      result = {
        id: subaccounts.length + 1,
        subaccount_code: `ACCT_${randomUUID()}`,
        account_number: body.account_number,
        currency: 'NGN',
        bank: 9,
        active: true,
        is_verified: true,
        metadata: body.metadata,
      };
      subaccounts.push(result);
      if (lostSubaccount) {
        lostSubaccount = false;
        throw new Error('Synthetic lost subaccount response');
      }
    } else if (path.startsWith('/subaccount/') && options.method === 'PUT') {
      const previous = subaccounts.find(
        (entry) =>
          entry.subaccount_code === decodeURIComponent(path.split('/').at(-1)),
      );
      assert(previous);
      Object.assign(previous, {
        account_number: body.account_number,
        metadata: body.metadata,
      });
      result = { ...previous };
    } else if (path === '/transferrecipient' && options.method === 'POST') {
      const key = `${body.bank_code}:${body.account_number}`;
      if (!recipients.has(key))
        recipients.set(key, {
          recipient_code: `RCP_${randomUUID()}`,
          id: randomUUID(),
          active: true,
          currency: 'NGN',
          details: {
            bank_code: body.bank_code,
            account_number: body.account_number,
          },
        });
      result = { ...recipients.get(key) };
      if (lostRecipient) {
        lostRecipient = false;
        throw new Error('Synthetic lost recipient response');
      }
    } else if (path.startsWith('/transferrecipient/')) {
      const code = decodeURIComponent(path.split('/').at(-1));
      result = [...recipients.values()].find(
        (entry) => entry.recipient_code === code,
      );
      assert(result);
      if (options.method === 'DELETE') result.active = false;
      result = { ...result };
    } else throw new Error('Unexpected synthetic provider route');
    if (beforeResponse) {
      const callback = beforeResponse;
      beforeResponse = undefined;
      await callback(path);
    }
    return result;
  };
  const sync = () =>
    new StorePaymentAccountSynchronizer(
      wrapped,
      provider,
      [encryptionKey],
      identity,
    );
  const sealAccount = (value) => `synthetic-encrypted-${value.slice(-4)}`;
  const apply = async (command, synchronizer = sync()) => {
    const actor = actors.get(command.actorId),
      secret = randomBytes(32).toString('base64url'),
      id = randomUUID();
    assert(actor);
    const operation = {
      actor,
      policy: {
        action: 'brand.payout-account.change',
        sensitivity: 'CRITICAL_CHANGE',
        scope: 'BRAND_OWNER',
        brandId: command.brandId,
      },
      method: 'PATCH',
      path: '/store/payment-account',
      route: '/store/payment-account',
      body: command,
      serverState:
        await require('../src/auth/access/payout-account-approval-state').payoutAccountApprovalState(
          prisma,
          command.brandId,
        ),
      requiredAdminPermissions: [],
      operationDigest: `disposable-bank-${randomUUID()}`,
      requestId: randomUUID(),
      proof: `${id}.${secret}`,
    };
    await prisma.securityStepUpChallenge.create({
      data: {
        id,
        userId: actor.id,
        sessionId: actor.sid,
        authVersion: actor.authVersion,
        operationDigest: operation.operationDigest,
        method: 'PATCH',
        route: operation.route,
        sensitivity: 'CRITICAL_CHANGE',
        nonce: randomBytes(32).toString('base64url'),
        proofHash: secretDigest(secret),
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return securityRequestContext.run(
      { operation, request: createSecurityLease() },
      () => synchronizer.synchronize(command, sealAccount),
    );
  };
  const command = (
    actor,
    accountNumber,
    previous = null,
    devBypass = false,
  ) => ({
    brandId: actor.brandId,
    actorId: actor.actor.id,
    businessName: 'Fixture brand',
    bankCode: '058',
    bankName: 'Fixture bank',
    accountNumber,
    primaryContactName: 'Fixture contact',
    primaryContactEmail: 'fixture@example.invalid',
    primaryContactPhone: null,
    previous,
    devBypass,
  });
  const previous = (account) => ({
    updatedAt: account.updatedAt.toISOString(),
    subaccountCode: account.subaccountCode,
    recipientCode: account.transferRecipientCode,
    bankFingerprint: account.bankClaimFingerprint,
  });
  const first = await owner(),
    second = await owner();
  await assert.rejects(
    () =>
      sync().synchronize(command(first, '1234567890', null, true), sealAccount),
    (error) => error.getStatus() === 403,
  );
  record(
    'an internal bank-change call without live human action approval is rejected before provider work',
  );
  const concurrent = await Promise.allSettled([
    apply(command(first, '1234567890', null, true)),
    apply(command(second, '1234567890', null, true)),
  ]);
  assert.equal(
    concurrent.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  const rejected = concurrent.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.getStatus(), 409);
  assert.equal(
    await prisma.storePaymentAccount.count({
      where: { brandId: { in: [first.brandId, second.brandId] } },
    }),
    1,
  );
  assert.equal(calls.length, 0);
  record(
    'two simultaneous brands claiming one bank produce one account and one safe conflict, including test-bank bypass',
  );

  const interrupted = await owner(),
    interruptedCommand = command(interrupted, '1234567891');
  lostSubaccount = true;
  await assert.rejects(
    () => apply(interruptedCommand),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    (
      await prisma.storePaymentAccountSync.findFirstOrThrow({
        where: { brandId: interrupted.brandId },
      })
    ).stage,
    'SUBACCOUNT_CREATE_UNKNOWN',
  );
  const creates = calls.filter((call) => call.path === '/subaccount').length;
  const recovered = await apply(interruptedCommand);
  assert.equal(
    calls.filter((call) => call.path === '/subaccount').length,
    creates,
  );
  assert.equal(recovered.status, 'ACTIVE');
  record(
    'a lost subaccount-create response reconciles its saved attempt metadata without a second create',
  );
  const row = await prisma.storePaymentAccountSync.findFirstOrThrow({
    where: { brandId: interrupted.brandId },
  });
  assert(!row.commandEncrypted.includes(interruptedCommand.accountNumber));
  assert(
    !row.commandEncrypted.includes(interruptedCommand.primaryContactEmail),
  );
  record(
    'durable bank commands and provider checkpoints contain ciphertext rather than plaintext account/contact details',
  );

  const recipientLost = await owner(),
    recipientCommand = command(recipientLost, '1234567892');
  lostRecipient = true;
  await assert.rejects(
    () => apply(recipientCommand),
    (error) => error.getStatus() === 409,
  );
  const subCreates = calls.filter((call) => call.path === '/subaccount').length;
  await apply(recipientCommand);
  assert.equal(
    calls.filter((call) => call.path === '/subaccount').length,
    subCreates,
  );
  assert.equal(
    [...recipients.values()].filter(
      (entry) =>
        entry.details.account_number === recipientCommand.accountNumber,
    ).length,
    1,
  );
  record(
    'a lost recipient response uses documented duplicate-recipient recovery and preserves the completed subaccount checkpoint',
  );

  const revoked = await owner(),
    revokedCommand = command(revoked, '1234567893');
  const secret = randomBytes(32).toString('base64url'),
    proofId = randomUUID(),
    lease = createSecurityLease();
  const operation = {
    actor: revoked.actor,
    policy: {
      action: 'brand.payout-account.change',
      sensitivity: 'CRITICAL_CHANGE',
      scope: 'BRAND_OWNER',
      brandId: revoked.brandId,
    },
    method: 'PATCH',
    path: '/store/payment-account',
    route: '/store/payment-account',
    body: revokedCommand,
    requiredAdminPermissions: [],
    operationDigest: 'disposable-bank-approval',
    requestId: randomUUID(),
    proof: `${proofId}.${secret}`,
  };
  operation.serverState =
    await require('../src/auth/access/payout-account-approval-state').payoutAccountApprovalState(
      prisma,
      revoked.brandId,
    );
  await prisma.securityStepUpChallenge.create({
    data: {
      id: proofId,
      userId: revoked.actor.id,
      sessionId: revoked.actor.sid,
      authVersion: revoked.actor.authVersion,
      operationDigest: operation.operationDigest,
      method: 'PATCH',
      route: operation.route,
      sensitivity: 'CRITICAL_CHANGE',
      nonce: randomBytes(32).toString('base64url'),
      proofHash: secretDigest(secret),
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  let consumedBeforeLogout = false;
  beforeResponse = async () => {
    consumedBeforeLogout =
      (
        await prisma.securityStepUpChallenge.findUniqueOrThrow({
          where: { id: proofId },
        })
      ).usedByRequestId === operation.requestId;
    lease.close();
    await securityRequestContext.exit(() =>
      tokenService.revokeCurrentSession(revoked.actor.id, revoked.actor.sid),
    );
  };
  const applied = await securityRequestContext.run(
    { operation, request: lease },
    () => sync().synchronize(revokedCommand, sealAccount),
  );
  assert.equal(applied.status, 'ACTIVE');
  assert(
    consumedBeforeLogout,
    'Approval must commit with admission before the first provider call',
  );
  assert.equal(
    await prisma.securityStepUpChallenge.count({ where: { id: proofId } }),
    0,
    'Logout cascades the session-bound challenge',
  );
  record(
    'an approved bank command records its admitted outcome after request cancellation and logout without reusing human authority',
  );

  const stale = await owner(),
    staleCommand = command(stale, '1234567888');
  const staleSecret = randomBytes(32).toString('base64url'),
    staleProofId = randomUUID();
  const staleOperation = {
    ...operation,
    actor: stale.actor,
    body: staleCommand,
    policy: { ...operation.policy, brandId: stale.brandId },
    requestId: randomUUID(),
    proof: `${staleProofId}.${staleSecret}`,
    serverState:
      await require('../src/auth/access/payout-account-approval-state').payoutAccountApprovalState(
        prisma,
        stale.brandId,
      ),
  };
  await prisma.securityStepUpChallenge.create({
    data: {
      id: staleProofId,
      userId: stale.actor.id,
      sessionId: stale.actor.sid,
      authVersion: stale.actor.authVersion,
      operationDigest: staleOperation.operationDigest,
      method: 'PATCH',
      route: staleOperation.route,
      sensitivity: 'CRITICAL_CHANGE',
      nonce: randomBytes(32).toString('base64url'),
      proofHash: secretDigest(staleSecret),
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const changedAccount = await prisma.storePaymentAccount.create({
    data: { brandId: stale.brandId },
  });
  const callsAtStateChange = calls.length;
  await assert.rejects(
    () =>
      securityRequestContext.run(
        { operation: staleOperation, request: createSecurityLease() },
        () => sync().synchronize(staleCommand, sealAccount),
      ),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    (
      await prisma.securityStepUpChallenge.findUniqueOrThrow({
        where: { id: staleProofId },
      })
    ).usedAt,
    null,
  );
  assert.equal(calls.length, callsAtStateChange);
  await prisma.storePaymentAccount.delete({ where: { id: changedAccount.id } });
  record(
    'an account change after action verification rejects admission and rolls back proof consumption before provider calls',
  );

  const fenced = await owner(),
    fencedCommand = command(fenced, '1234567894');
  beforeResponse = async () => {
    await prisma.storePaymentAccountSync.updateMany({
      where: { brandId: fenced.brandId, finishedAt: null },
      data: { leaseToken: randomUUID() },
    });
  };
  const callsBefore = calls.length;
  await assert.rejects(
    () => apply(fencedCommand),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    await prisma.storePaymentAccount.count({
      where: { brandId: fenced.brandId },
    }),
    0,
  );
  assert.equal(calls.length - callsBefore, 1);
  record(
    'a replaced bank-sync lease prevents stale provider responses from applying state or issuing the next provider command',
  );

  const nextCommand = command(interrupted, '1234567895', previous(recovered));
  lostRecipient = true;
  await assert.rejects(
    () => apply(nextCommand),
    (error) => error.getStatus() === 409,
  );
  const stillActive = await prisma.storePaymentAccount.findUniqueOrThrow({
    where: { brandId: interrupted.brandId },
  });
  assert.equal(
    stillActive.transferRecipientCode,
    recovered.transferRecipientCode,
  );
  assert.equal(stillActive.status, 'ACTIVE');
  assert.equal(stillActive.accountNumberLast4, recovered.accountNumberLast4);
  record(
    'a failed bank replacement leaves the previous active account and recipient intact',
  );
  const updated = await apply(nextCommand);
  assert.notEqual(
    updated.transferRecipientCode,
    recovered.transferRecipientCode,
  );
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
  const payout = await prisma.payout.create({
    data: {
      id: randomUUID(),
      brandId: interrupted.brandId,
      amount: 100,
      providerRecipientCode: recovered.transferRecipientCode,
      status: 'PROCESSING',
    },
  });
  await sync().retireUnusedRecipients();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
  record(
    'bank replacement preserves the old recipient while an already-admitted payout still depends on it',
  );
  await prisma.payout.update({
    where: { id: payout.id },
    data: { status: 'PAID' },
  });
  beforeResponse = async () => {
    await prisma.storePayoutRecipientRetirement.update({
      where: { recipientCode: recovered.transferRecipientCode },
      data: { leaseToken: randomUUID() },
    });
  };
  await sync().retireUnusedRecipients();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
  await prisma.storePayoutRecipientRetirement.update({
    where: { recipientCode: recovered.transferRecipientCode },
    data: { leaseExpiresAt: new Date(0) },
  });
  record(
    'replacing the retirement lease during provider lookup prevents its stale executor from deleting the recipient',
  );
  await sync().retireUnusedRecipients();
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(
    await prisma.storePayoutBankClaim.count({
      where: { fingerprint: recovered.bankClaimFingerprint },
    }),
    0,
  );
  record(
    'safe recipient retirement deactivates only an unused old recipient and releases its obsolete bank claim',
  );

  const rotate = new StorePaymentAccountSynchronizer(
    wrapped,
    provider,
    [encryptionKey],
    new StoreBankIdentity(randomBytes(32).toString('base64')),
  );
  const countBefore = calls.length;
  const rotationActor = await owner();
  await assert.rejects(
    () => apply(command(rotationActor, '1234567896'), rotate),
    (error) => error.getStatus() === 503,
  );
  assert.equal(calls.length, countBefore);
  record(
    'changing the stable bank identity key fails closed before provider calls instead of permitting duplicate bank ownership',
  );
  // Prove FK/cascade behavior for an account that actually owns a bank claim.
  await prisma.brand.delete({ where: { id: old.brandId } });
  assert.equal(
    await prisma.storePayoutBankClaim.count({
      where: { brandId: old.brandId },
    }),
    0,
  );
  record(
    'brand deletion cascades its account and bank claim without foreign-key ordering failures',
  );
};
