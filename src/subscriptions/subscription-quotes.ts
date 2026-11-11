import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  Prisma,
  type BrandSubscription,
  type SubscriptionTierKey,
} from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import { getLiveSecurityContext } from 'src/auth/access/security-request-context';
import { savedPaymentMethodApprovalState } from 'src/payment/saved-payment-method-version';

export type BillingQuote = {
  kind: 'INITIAL' | 'UPGRADE' | 'DOWNGRADE' | 'UNCHANGED';
  amountNgn: number;
  targetMonthlyPriceNgn: number;
  effectiveAt: Date;
  periodEnd: Date;
  current: BrandSubscription | null;
};
const quoteChanged = () =>
  new ConflictException({
    code: 'SUBSCRIPTION_QUOTE_EXPIRED',
    message:
      'This price quote expired or billing changed. Review a fresh quote and approve it before paying.',
  });
export const SUBSCRIPTION_QUOTE_TTL_MS = 300_000;

/** Routine timestamps must not invalidate a price; material agreement changes must. */
export function subscriptionAgreementFingerprint(
  current: BrandSubscription | null,
): string | null {
  if (!current) return null;
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: current.id,
        tier: current.tierKey,
        status: current.status,
        price: String(current.priceSnapshotNgn),
        from: current.currentPeriodStart.toISOString(),
        until: current.currentPeriodEnd.toISOString(),
        anchor: current.billingAnchorDay,
        cancel: current.cancelAtPeriodEnd,
        nextTier: current.scheduledTierKey,
        nextPrice: current.scheduledPriceSnapshotNgn,
        card: current.savedPaymentMethodId,
        authorizationVersion: createHash('sha256')
          .update(current.providerAuthorizationCode ?? '')
          .digest('hex'),
        email: current.providerCustomerEmail,
        consent: current.recurringConsentAt?.toISOString() ?? null,
        terms: current.recurringPolicyVersion,
      }),
    )
    .digest('hex');
}

export async function subscriptionDatabaseNow(tx: Prisma.TransactionClient) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  if (!(clock?.now instanceof Date)) throw quoteChanged();
  return clock.now;
}

export async function saveSubscriptionQuote(
  tx: Prisma.TransactionClient,
  owner: { actorId: string; brandId: string; tierKey: SubscriptionTierKey },
  quote: BillingQuote,
  now: Date,
) {
  return tx.brandSubscriptionQuote.create({
    data: {
      ...owner,
      kind: quote.kind,
      amount: quote.amountNgn,
      monthlyPriceNgn: quote.targetMonthlyPriceNgn,
      currency: 'NGN',
      agreementFingerprint: subscriptionAgreementFingerprint(quote.current),
      periodStart: quote.effectiveAt,
      periodEnd: quote.periodEnd,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SUBSCRIPTION_QUOTE_TTL_MS),
    },
  });
}

export async function loadHeldSubscriptionQuote(
  tx: Prisma.TransactionClient,
  id: string,
  owner: { actorId: string; brandId: string; tierKey: SubscriptionTierKey },
  current: BrandSubscription | null,
  now: Date,
) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw quoteChanged();
  const quote = await tx.brandSubscriptionQuote.findFirst({
    where: { id, ...owner },
  });
  if (
    !quote ||
    quote.expiresAt <= now ||
    quote.usedAt ||
    quote.currency !== 'NGN' ||
    quote.agreementFingerprint !== subscriptionAgreementFingerprint(current)
  )
    throw quoteChanged();
  return {
    record: quote,
    billing: {
      kind: quote.kind as BillingQuote['kind'],
      amountNgn: Number(quote.amount),
      targetMonthlyPriceNgn: Number(quote.monthlyPriceNgn),
      effectiveAt: quote.periodStart,
      periodEnd: quote.periodEnd,
      current,
    } satisfies BillingQuote,
  };
}

/** Consume with the approved financial mutation; rollback restores quote and proof together. */
export async function consumeSubscriptionQuote(
  tx: Prisma.TransactionClient,
  id: string,
  invoiceId: string | null,
) {
  const context = getLiveSecurityContext();
  if (!context) throw quoteChanged();
  const now = await subscriptionDatabaseNow(tx);
  const consumed = await tx.brandSubscriptionQuote.updateMany({
    where: {
      id,
      actorId: context.operation.actor.id,
      brandId: context.operation.policy.brandId,
      expiresAt: { gt: now },
      usedAt: null,
    },
    data: {
      usedAt: now,
      usedByRequestId: context.operation.requestId,
      invoiceId,
    },
  });
  if (consumed.count !== 1) throw quoteChanged();
}

/** Included in exact-action approval before the controller can prepare a payment. */
export async function subscriptionQuoteApprovalState(
  client: PrismaService | Prisma.TransactionClient,
  id: unknown,
  brandId: string,
  actorId: string,
  savedCardId?: unknown,
) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw quoteChanged();
  const quote = await client.brandSubscriptionQuote.findFirst({
    where: { id, brandId, actorId },
  });
  if (!quote || quote.expiresAt.getTime() <= Date.now() || quote.usedAt)
    throw quoteChanged();
  return {
    ...(await savedPaymentMethodApprovalState(client, actorId, savedCardId)),
    subscriptionQuote: {
      id: quote.id,
      brandId,
      actorId,
      tierKey: quote.tierKey,
      kind: quote.kind,
      amountNgn: quote.amount.toString(),
      monthlyPriceNgn: quote.monthlyPriceNgn.toString(),
      currency: quote.currency,
      periodStart: quote.periodStart.toISOString(),
      periodEnd: quote.periodEnd.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
      agreementFingerprint: quote.agreementFingerprint,
    },
  };
}
