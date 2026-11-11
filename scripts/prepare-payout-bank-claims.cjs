// One-time release preparation. Never logs bank data, ciphertext, tokens or secret values.
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const {
  StoreBankIdentity,
} = require('../src/store/store-payment-account-sync');
const { StoreService } = require('../src/store/store.service');
const { PrismaService } = require('../src/prisma/prisma.service');

async function preparePayoutBankClaims(prisma, identity, decrypt) {
  await prisma.$transaction(async (tx) => {
    const [state] =
      await tx.$queryRaw`SELECT "keyId" FROM "StorePayoutIdentityState" WHERE "id"='payout-bank-v1' FOR UPDATE`;
    if (
      !state ||
      (state.keyId && state.keyId !== identity.keyId) ||
      (await tx.storePayoutBankClaim.findFirst({
        where: { keyId: { not: identity.keyId } },
        select: { fingerprint: true },
      }))
    ) {
      throw new Error(
        'The bank identity key differs from existing claims. Restore the configured identity key; do not silently rotate it.',
      );
    }
    if (
      await tx.storePaymentAccountSync.findFirst({
        where: { finishedAt: null },
        select: { id: true },
      })
    ) {
      throw new Error(
        'Finish or reconcile pending payout-account updates before preparation.',
      );
    }
    await tx.storePayoutIdentityState.update({
      where: { id: 'payout-bank-v1' },
      data: { keyId: identity.keyId, ready: false },
    });
  });
  let cursor,
    prepared = 0;
  for (;;) {
    const rows = await prisma.storePaymentAccount.findMany({
      where: { accountNumberEncrypted: { not: null } },
      orderBy: { id: 'asc' },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const row of rows) {
      const number = decrypt(row.accountNumberEncrypted);
      if (!number || !row.bankCode)
        throw new Error(
          'An existing payout account cannot be verified. No account data was deleted.',
        );
      const fingerprint = identity.fingerprint(row.bankCode, number);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "_id" FROM "Brand" WHERE "_id"=${row.brandId}::uuid FOR UPDATE`;
        const current = await tx.storePaymentAccount.findUniqueOrThrow({
          where: { id: row.id },
        });
        if (current.updatedAt.getTime() !== row.updatedAt.getTime())
          throw new Error(
            'A payout account changed during preparation. Retry preparation.',
          );
        await tx.storePayoutBankClaim.createMany({
          data: {
            fingerprint,
            brandId: row.brandId,
            keyId: identity.keyId,
            recipientCode: row.transferRecipientCode,
          },
          skipDuplicates: true,
        });
        const claim = await tx.storePayoutBankClaim.findUnique({
          where: { fingerprint },
        });
        if (
          !claim ||
          claim.brandId !== row.brandId ||
          claim.recipientCode !== row.transferRecipientCode
        ) {
          throw new Error(
            'Payout bank ownership conflict. Resolve ownership before enabling account updates.',
          );
        }
        await tx.storePaymentAccount.update({
          where: { id: row.id },
          data: { bankClaimFingerprint: fingerprint },
        });
      });
      prepared++;
    }
    cursor = rows.at(-1).id;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "StorePayoutIdentityState" WHERE "id"='payout-bank-v1' FOR UPDATE`;
    if (
      await tx.storePaymentAccount.findFirst({
        where: {
          accountNumberEncrypted: { not: null },
          OR: [
            { bankClaimFingerprint: null },
            { bankClaim: { is: { keyId: { not: identity.keyId } } } },
          ],
        },
        select: { id: true },
      })
    ) {
      throw new Error(
        'Some payout accounts still need preparation. Updates remain closed.',
      );
    }
    await tx.storePayoutIdentityState.update({
      where: { id: 'payout-bank-v1' },
      data: { keyId: identity.keyId, ready: true },
    });
  });
  return { prepared, identityKeyId: identity.keyId };
}
module.exports = { preparePayoutBankClaims };
if (require.main === module) {
  if (!process.argv.includes('--apply')) {
    console.error(
      'No changes made. Configure the target environment and use --apply after deploying the additive migration.',
    );
    process.exitCode = 1;
  } else {
    const prisma = new PrismaService();
    (async () => {
      try {
        const identity = new StoreBankIdentity();
        const store = new StoreService(prisma, {}, {}, {});
        console.log(
          JSON.stringify(
            await preparePayoutBankClaims(prisma, identity, (value) =>
              store.decryptStorePaymentValue(value),
            ),
          ),
        );
      } catch (error) {
        console.error(
          error instanceof Error && !('code' in error)
            ? error.message
            : 'Payout bank preparation failed. Inspect ownership and configuration; no secret values were logged.',
        );
        process.exitCode = 1;
      } finally {
        await prisma.$disconnect();
      }
    })();
  }
}
