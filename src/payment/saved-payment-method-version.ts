import { createHash } from 'crypto';
import type { Prisma, SavedPaymentMethod } from '@prisma/client';
import { ConflictException } from '@nestjs/common';

/** Excludes last-used bookkeeping; includes the credential and its usable identity. */
export function savedPaymentMethodVersion(
  card: Pick<
    SavedPaymentMethod,
    | 'id'
    | 'buyerId'
    | 'status'
    | 'provider'
    | 'paymentMethod'
    | 'providerAuthorizationCodeEncrypted'
    | 'providerAuthorizationMeta'
    | 'expMonth'
    | 'expYear'
  >,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: card.id,
        buyer: card.buyerId,
        status: card.status,
        provider: card.provider,
        paymentMethod: card.paymentMethod,
        credential: card.providerAuthorizationCodeEncrypted,
        metadata: card.providerAuthorizationMeta,
        month: card.expMonth,
        year: card.expYear,
      }),
    )
    .digest('hex');
}

export async function savedPaymentMethodApprovalState(
  client: Pick<Prisma.TransactionClient, 'savedPaymentMethod'>,
  actorId: string,
  savedCardId?: unknown,
) {
  if (savedCardId === undefined || savedCardId === null)
    return { subscriptionPaymentMethod: null };
  if (
    typeof savedCardId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      savedCardId,
    )
  )
    throw new ConflictException(
      'Select a current saved card and verify this action again.',
    );
  const card = await client.savedPaymentMethod.findFirst({
    where: {
      id: savedCardId,
      buyerId: actorId,
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      paymentMethod: 'PAYSTACK',
    },
  });
  if (!card)
    throw new ConflictException(
      'This saved card changed. Review and verify it again.',
    );
  return {
    subscriptionPaymentMethod: {
      id: card.id,
      version: savedPaymentMethodVersion(card),
    },
  };
}
