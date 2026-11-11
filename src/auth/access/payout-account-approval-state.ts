import type { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';

/** Defaults inherited from an existing account are part of what the owner approves. */
export async function payoutAccountApprovalState(
  client: PrismaService | Prisma.TransactionClient,
  brandId: string,
) {
  const account = await client.storePaymentAccount.findUnique({
    where: { brandId },
    select: {
      id: true,
      updatedAt: true,
      transferRecipientCode: true,
      bankClaimFingerprint: true,
    },
  });
  return {
    payoutAccount: {
      brandId,
      id: account?.id ?? null,
      updatedAt: account?.updatedAt.toISOString() ?? null,
      recipientCode: account?.transferRecipientCode ?? null,
      bankFingerprint: account?.bankClaimFingerprint ?? null,
    },
  };
}
