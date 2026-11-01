import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SUBSCRIPTION_TIER_ORDER as TIER_ORDER } from './subscription-tiers';
import {
  BrandSubscription,
  BrandSubscriptionInvoice,
  BrandVerificationStatus,
  LegalAcceptanceSource,
  LegalDocumentKey,
  NotificationType,
  Prisma,
  Role,
  SubscriptionTierKey,
  UserType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { Request } from 'express';
import { PaymentService } from '../payment/payment.service';
import type { ForwardRefType } from '../common/types/forward-ref-type';
import { PrismaService } from '../prisma/prisma.service';
import { BrandAccessService } from '../brands/brand-access.service';
import { LegalService } from '../legal/legal.service';
import { LEGAL_VERSION } from '../legal/legal.constants';
import { renderNotificationEmail } from '../notifications/email.policy';
import { ADMIN_PERMISSIONS } from '../admin/constants/permissions';
import {
  SubscriptionCheckoutDto,
  SubscriptionHistoryQueryDto,
  SubscriptionPaymentMethodDto,
} from './subscription-checkout.dto';
import {
  SubscriptionPaystackService,
  SubscriptionProviderTransaction,
} from './subscription-paystack.service';
import {
  billingAnchorDay,
  nextBillingAnniversary,
  proratedUpgradeKobo,
  recoveryDeadline,
  renewalAttemptAt,
  subscriptionAttemptReference,
} from './subscription-billing.policy';
import {
  decryptSubscriptionAuthorization,
  encryptSubscriptionAuthorization,
  subscriptionAuthorizationStorageReady,
} from './subscription-authorization.crypto';
import {
  loadSubscriptionDebitContext,
  loadSubscriptionRenewalContext,
} from './subscription-renewal-query';
import {
  loadSubscriptionVerificationInvoice,
  SubscriptionVerificationInvoice,
} from './subscription-invoice-query';

const REQUIRED_TERMS = [
  LegalDocumentKey.TERMS_OF_SERVICE,
  LegalDocumentKey.SELLER_TERMS,
  LegalDocumentKey.PAYMENT_POLICY,
];
type CompensationInvoiceContext = Pick<
  BrandSubscriptionInvoice,
  'id' | 'amount' | 'currency'
> & {
  subscription: Pick<BrandSubscription, 'brandId'>;
};
type BillingQuote = {
  kind: 'INITIAL' | 'UPGRADE' | 'DOWNGRADE' | 'UNCHANGED';
  amountNgn: number;
  effectiveAt: Date;
  periodEnd: Date;
  current: BrandSubscription | null;
};
export type SubscriptionAdminActor = {
  id: string;
  role: Role;
  permissions?: string[];
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
    private readonly legal: LegalService,
    private readonly paystack: SubscriptionPaystackService,
    @Optional()
    @Inject(forwardRef(() => PaymentService))
    private readonly payments?: ForwardRefType<PaymentService>,
  ) {}

  private async lock(tx: Prisma.TransactionClient, brandId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wiez-subscription-' + brandId}))`;
  }

  /** Financial change, inbox receipt and transactional email commit atomically. */
  private async notifyBilling(
    tx: Prisma.TransactionClient,
    brandId: string,
    eventKey: string,
    heading: string,
    message: string,
  ) {
    const [brand] = await tx.$queryRaw<
      Array<{ ownerId: string; email: string | null }>
    >(Prisma.sql`
      SELECT b."ownerId", u.email FROM "Brand" b
      JOIN "User" u ON u."_id" = b."ownerId"
      WHERE b."_id" = ${brandId}::uuid
    `);
    if (!brand) return;
    const targetUrl = `/settings?tab=subscription-billing&brandId=${brandId}`;
    const notificationId = uuidv5(`wiez-subscription-${eventKey}`, uuidv5.URL);
    const payload = {
      action: 'SUBSCRIPTION_BILLING',
      brandId,
      message,
      targetUrl,
    };
    await tx.notification.createMany({
      data: [
        {
          id: notificationId,
          recipientId: brand.ownerId,
          type: NotificationType.ADMIN_ACTION,
          payload,
        },
      ],
      skipDuplicates: true,
    });
    if (!brand.email) return;
    const base = String(
      process.env.WEB_APP_URL ?? process.env.FRONTEND_URL ?? 'https://wiez.com',
    ).replace(/\/$/, '');
    const rendered = renderNotificationEmail({
      appName: 'WIEZ',
      heading,
      message,
      targetUrl: `${base}${targetUrl}`,
      notificationType: NotificationType.ADMIN_ACTION,
      payload,
    });
    await tx.emailOutbox.createMany({
      data: [
        {
          recipientUserId: brand.ownerId,
          recipientEmailSnapshot: brand.email.toLowerCase(),
          scenarioKey: 'billing.subscription.transactional',
          notificationType: NotificationType.ADMIN_ACTION,
          subject: heading,
          html: rendered.html,
          text: rendered.text,
          payloadJson: payload,
          priority: 'P1_TRANSACTIONAL',
          idempotencyKey: `subscription-${eventKey}`,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async compensationAttention(
    tx: Prisma.TransactionClient,
    invoice: CompensationInvoiceContext,
    reference: string,
    reason: string,
  ) {
    await tx.operationalAlert.upsert({
      where: { dedupeKey: `subscription-capture-${reference}` },
      create: {
        category: 'FINANCE',
        event: 'SUBSCRIPTION_COMPENSATION_REQUIRED',
        severity: 'HIGH',
        title: 'Subscription capture requires compensation',
        message: reason,
        entityType: 'BrandSubscriptionInvoice',
        entityId: invoice.id,
        dedupeKey: `subscription-capture-${reference}`,
        metadata: {
          brandId: invoice.subscription.brandId,
          reference,
          amountNgn: Number(invoice.amount),
          currency: invoice.currency,
        },
      },
      update: { lastSeenAt: new Date(), occurrenceCount: { increment: 1 } },
    });
    await this.notifyBilling(
      tx,
      invoice.subscription.brandId,
      `compensation-${reference}`,
      'Subscription payment compensation',
      'A subscription payment was captured but did not change your access. Its full refund is being reconciled. Check the billing history for progress; bank credit is not instant.',
    );
  }

  private current(
    tx: Prisma.TransactionClient | PrismaService,
    brandId: string,
  ) {
    return tx.brandSubscription.findFirst({
      where: { brandId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private presentSubscription(
    subscription: BrandSubscription | null,
    now = new Date(),
  ) {
    if (!subscription) return null;
    return {
      id: subscription.id,
      tierKey: subscription.tierKey,
      status:
        subscription.status === 'ACTIVE' && subscription.currentPeriodEnd <= now
          ? subscription.cancelAtPeriodEnd
            ? 'CANCELLED'
            : 'PAST_DUE'
          : subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      lockedMonthlyPriceNgn: subscription.priceSnapshotNgn,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      pendingTierKey: subscription.scheduledTierKey,
      recoveryUntil: subscription.recoveryUntil,
      intakeEnabled:
        subscription.status === 'ACTIVE' && subscription.currentPeriodEnd > now,
      recurringAuthorized: Boolean(
        subscription.recurringConsentAt &&
          decryptSubscriptionAuthorization(
            subscription.providerAuthorizationCode,
            subscription.brandId,
          ),
      ),
      savedPaymentMethodId: subscription.savedPaymentMethodId ?? null,
      billingTimezone: 'Africa/Lagos',
    };
  }

  async getForOwner(userId: string, brandId: string) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    const now = new Date();
    const [current, tiers, invoices, brand] = await Promise.all([
      this.current(this.prisma, resolved.brandId),
      this.prisma.subscriptionTier.findMany({
        orderBy: { monthlyPriceNgn: 'asc' },
      }),
      this.prisma.brandSubscriptionInvoice.findMany({
        where: { subscription: { brandId: resolved.brandId } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          captures: {
            where: { status: { not: 'APPLIED' } },
            select: {
              reference: true,
              amount: true,
              currency: true,
              status: true,
              reason: true,
              refundedAt: true,
              lastError: true,
            },
          },
        },
      }),
      this.prisma.brand.findUnique({
        where: { id: resolved.brandId },
        select: {
          assignedSubscriptionTierKey: true,
        },
      }),
    ]);
    const pending = current
      ? null
      : await this.prisma.brandSubscription.findFirst({
          where: { brandId: resolved.brandId },
          orderBy: { createdAt: 'desc' },
        });
    return {
      subscription: this.presentSubscription(current ?? pending, now),
      assignedTierKey: brand?.assignedSubscriptionTierKey ?? null,
      tiers: tiers.map((tier) => ({
        ...tier,
        tierKey: tier.key,
        label: tier.name,
      })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        reference: invoice.reference,
        amountNgn: Number(invoice.amount),
        currency: invoice.currency,
        status: invoice.status,
        createdAt: invoice.createdAt,
        paidAt: invoice.paidAt,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        authorizationUrl: invoice.authorizationUrl,
        compensations: invoice.captures.map((capture) => ({
          ...capture,
          amountNgn: Number(capture.amount),
        })),
      })),
      serverNow: now.toISOString(),
      legalVersion: LEGAL_VERSION,
    };
  }

  async historyForOwner(
    userId: string,
    brandId: string,
    query: SubscriptionHistoryQueryDto,
  ) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    const billing = query.kind !== 'SUBSCRIPTIONS';
    const model = billing
      ? this.prisma.brandSubscriptionInvoice
      : this.prisma.brandSubscription;
    const where = billing
      ? { subscription: { brandId: resolved.brandId } }
      : { brandId: resolved.brandId };
    // A cursor must itself belong to this owner/brand; it never expands the scope.
    if (
      query.cursor &&
      !(await (model as any).findFirst({
        where: { ...where, id: query.cursor },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('History page not found.');
    }
    const rows = await (model as any).findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 26,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: billing
        ? {
            id: true,
            reference: true,
            amount: true,
            currency: true,
            status: true,
            createdAt: true,
            paidAt: true,
            periodStart: true,
            periodEnd: true,
            purpose: true,
            subscription: { select: { tierKey: true } },
          }
        : {
            id: true,
            tierKey: true,
            status: true,
            priceSnapshotNgn: true,
            createdAt: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            cancelRequestedAt: true,
            scheduledTierKey: true,
          },
    });
    const visible = rows.slice(0, 25);
    return {
      items: visible.map((row: any) =>
        billing
          ? {
              id: row.id,
              reference: row.reference,
              amountNgn: Number(row.amount),
              currency: row.currency,
              status: row.status,
              createdAt: row.createdAt,
              paidAt: row.paidAt,
              periodStart: row.periodStart,
              periodEnd: row.periodEnd,
              purpose: row.purpose,
              tierKey: row.subscription.tierKey,
            }
          : {
              ...this.presentSubscription(row),
              createdAt: row.createdAt,
              cancelRequestedAt: row.cancelRequestedAt,
            },
      ),
      nextCursor: rows.length > 25 ? visible[24].id : null,
    };
  }

  async claimNotice(userId: string, brandId: string) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, resolved.brandId);
      const now = new Date();
      const [subscription, receipt] = await Promise.all([
        this.current(tx, resolved.brandId),
        tx.subscriptionNoticeReceipt.findUnique({
          where: { userId_brandId: { userId, brandId: resolved.brandId } },
        }),
      ]);
      const paid =
        subscription?.status === 'ACTIVE' &&
        subscription.currentPeriodEnd > now;
      if (
        (paid && subscription.tierKey === 'IGWE') ||
        (receipt &&
          now.getTime() - receipt.lastShownAt.getTime() < 24 * 60 * 60_000)
      )
        return { notice: null };
      const tierKey = paid
        ? TIER_ORDER[TIER_ORDER.indexOf(subscription.tierKey) + 1]
        : 'THREAD';
      const tier = await tx.subscriptionTier.findUnique({
        where: { key: tierKey },
      });
      if (!tier || tier.monthlyPriceNgn <= 0) return { notice: null };
      await tx.subscriptionNoticeReceipt.upsert({
        where: { userId_brandId: { userId, brandId: resolved.brandId } },
        create: { userId, brandId: resolved.brandId, lastShownAt: now },
        update: { lastShownAt: now, lastDismissedAt: null },
      });
      return {
        notice: {
          tierKey,
          title: 'Make room for your next big idea',
          message: `Want room for more orders? Explore ${tier.name} and give your next collection room to grow. Compare plans below, or find Billing & subscriptions in Settings.`,
          targetUrl: '/settings?tab=subscription-billing',
        },
      };
    });
  }

  async dismissNotice(userId: string, brandId: string) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    await this.prisma.subscriptionNoticeReceipt.updateMany({
      where: { userId, brandId: resolved.brandId },
      data: { lastDismissedAt: new Date() },
    });
    return { success: true };
  }

  async paymentMethods(userId: string, brandId: string) {
    await this.access.assertBrandOwnerAndResolve(userId, brandId);
    if (!this.payments)
      throw new ServiceUnavailableException(
        'Payment settings are temporarily unavailable.',
      );
    return this.payments.listSubscriptionPaymentCards(userId);
  }

  async changePaymentMethod(
    userId: string,
    brandId: string,
    dto: SubscriptionPaymentMethodDto,
    req?: Request,
  ) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    if (dto.recurringConsent !== true || dto.legalVersion !== LEGAL_VERSION)
      throw new BadRequestException(
        'Accept the current recurring-payment authorization.',
      );
    if (!this.payments || !subscriptionAuthorizationStorageReady())
      throw new ServiceUnavailableException(
        'Secure billing is temporarily unavailable.',
      );
    const selected = await this.payments.getSubscriptionSavedCard(
      userId,
      dto.savedCardId,
    );
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, resolved.brandId);
      const current = await this.current(tx, resolved.brandId);
      if (!current)
        throw new NotFoundException(
          'Choose a paid subscription before setting a renewal card.',
        );
      if (
        selected.savedPaymentMethodId &&
        !(await tx.savedPaymentMethod.findFirst({
          where: {
            id: selected.savedPaymentMethodId,
            buyerId: userId,
            status: 'ACTIVE',
          },
          select: { id: true },
        }))
      )
        throw new ConflictException(
          'This card changed. Refresh payment methods.',
        );
      await this.legal.recordAcceptedDocuments({
        userId,
        requiredKeys: REQUIRED_TERMS,
        acceptances: REQUIRED_TERMS.map((documentKey) => ({
          documentKey,
          version: LEGAL_VERSION,
        })),
        source: LegalAcceptanceSource.CHECKOUT,
        surface: 'brand-subscription-card-change',
        accountType: UserType.BRAND,
        req,
        tx,
        metadata: {
          recurringConsent: true,
          brandId: resolved.brandId,
          savedCardId: dto.savedCardId,
        },
      });
      await tx.brandSubscription.updateMany({
        where: {
          brandId: resolved.brandId,
          OR: [
            { id: current.id },
            {
              status: 'PENDING',
              invoices: {
                some: {
                  previousSubscriptionId: current.id,
                  purpose: 'RENEWAL',
                },
              },
            },
          ],
        },
        data: {
          savedPaymentMethodId: selected.savedPaymentMethodId,
          providerAuthorizationCode: encryptSubscriptionAuthorization(
            selected.authorizationCode,
            resolved.brandId,
          ),
          providerCustomerEmail: selected.authorizationEmail,
          recurringConsentAt: new Date(),
          recurringPolicyVersion: LEGAL_VERSION,
        },
      });
      await this.notifyBilling(
        tx,
        resolved.brandId,
        `card-${randomUUID()}`,
        'Subscription payment method updated',
        'Your renewal payment method has changed. Your plan, price and renewal cancellation setting are unchanged.',
      );
    });
    return { success: true };
  }

  private async quote(
    tx: Prisma.TransactionClient | PrismaService,
    brandId: string,
    tierKey: SubscriptionTierKey,
    now: Date,
  ): Promise<BillingQuote> {
    if (!TIER_ORDER.includes(tierKey))
      throw new BadRequestException(
        'Choose an available paid subscription tier.',
      );
    const tier = await tx.subscriptionTier.findUnique({
      where: { key: tierKey },
    });
    if (!tier || tier.monthlyPriceNgn <= 0)
      throw new BadRequestException(
        'This subscription tier is currently unavailable.',
      );
    const current = await this.current(tx, brandId);
    if (current?.status === 'ACTIVE' && current.currentPeriodEnd > now) {
      if (current.tierKey === tierKey)
        return {
          kind: 'UNCHANGED',
          amountNgn: 0,
          effectiveAt: now,
          periodEnd: current.currentPeriodEnd,
          current,
        };
      if (TIER_ORDER.indexOf(tierKey) < TIER_ORDER.indexOf(current.tierKey))
        return {
          kind: 'DOWNGRADE',
          amountNgn: tier.monthlyPriceNgn,
          effectiveAt: current.currentPeriodEnd,
          periodEnd: nextBillingAnniversary(
            current.currentPeriodEnd,
            current.billingAnchorDay ??
              billingAnchorDay(current.currentPeriodStart),
          ),
          current,
        };
      return {
        kind: 'UPGRADE',
        amountNgn:
          proratedUpgradeKobo(
            current.priceSnapshotNgn,
            tier.monthlyPriceNgn,
            current.currentPeriodStart,
            current.currentPeriodEnd,
            now,
          ) / 100,
        effectiveAt: now,
        periodEnd: current.currentPeriodEnd,
        current,
      };
    }
    if (
      current &&
      current.currentPeriodEnd <= now &&
      now <= recoveryDeadline(current.currentPeriodEnd) &&
      current.tierKey === tierKey &&
      !current.cancelAtPeriodEnd
    ) {
      return {
        kind: 'INITIAL',
        amountNgn: current.priceSnapshotNgn,
        effectiveAt: current.currentPeriodEnd,
        periodEnd: nextBillingAnniversary(
          current.currentPeriodEnd,
          current.billingAnchorDay ??
            billingAnchorDay(current.currentPeriodStart),
        ),
        current,
      };
    }
    return {
      kind: 'INITIAL',
      amountNgn: tier.monthlyPriceNgn,
      effectiveAt: now,
      periodEnd: nextBillingAnniversary(now),
      current,
    };
  }

  async previewForOwner(
    userId: string,
    brandId: string,
    tierKey: SubscriptionTierKey,
  ) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    const quote = await this.quote(
      this.prisma,
      resolved.brandId,
      tierKey,
      new Date(),
    );
    return {
      kind: quote.kind,
      amountNgn: quote.amountNgn,
      effectiveAt: quote.effectiveAt,
      periodEnd: quote.periodEnd,
      serverNow: new Date().toISOString(),
      legalVersion: LEGAL_VERSION,
    };
  }

  private callbackUrl(value?: string): string | undefined {
    if (!value) return undefined;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      throw new BadRequestException('Choose a valid billing return address.');
    }
    const configured = [
      process.env.WEB_APP_URL,
      process.env.FRONTEND_URL,
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL,
      process.env.FRONTEND_BASE_URL,
    ];
    const origins = new Set(
      configured.filter(Boolean).flatMap((entry) => {
        try {
          return [new URL(entry!).origin];
        } catch {
          return [];
        }
      }),
    );
    const local =
      process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1'].includes(target.hostname);
    if (
      (!origins.has(target.origin) && !local) ||
      target.username ||
      target.password ||
      !['http:', 'https:'].includes(target.protocol) ||
      (process.env.NODE_ENV === 'production' && target.protocol !== 'https:')
    ) {
      throw new BadRequestException(
        'The billing return address is not an allowed WIEZ address.',
      );
    }
    return target.toString();
  }

  async checkout(
    userId: string,
    brandId: string,
    dto: SubscriptionCheckoutDto,
    req?: Request,
  ) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    const brand = await this.prisma.brand.findUnique({
      where: { id: resolved.brandId },
      select: { verificationStatus: true },
    });
    if (brand && brand.verificationStatus !== BrandVerificationStatus.APPROVED) {
      throw new ForbiddenException(
        'Only verified brands are eligible for subscription tier upgrades.',
      );
    }
    if (dto.recurringConsent !== true || dto.legalVersion !== LEGAL_VERSION)
      throw new BadRequestException(
        'Accept the current subscription terms and recurring-payment authorization.',
      );
    if (!subscriptionAuthorizationStorageReady())
      throw new ServiceUnavailableException(
        'Secure subscription billing is temporarily unavailable. No charge has been initiated.',
      );
    const callbackUrl = this.callbackUrl(dto.callbackUrl);
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!owner?.email)
      throw new BadRequestException('A billing email is required.');
    const selectedCard = dto.savedCardId
      ? await this.payments?.getSubscriptionSavedCard(userId, dto.savedCardId)
      : null;
    if (dto.savedCardId && !selectedCard)
      throw new ServiceUnavailableException(
        'Saved-card checkout is temporarily unavailable.',
      );
    const existingPeriod = await this.current(this.prisma, resolved.brandId);
    if (existingPeriod && existingPeriod.currentPeriodEnd <= new Date())
      await this.prepareRenewal(
        existingPeriod.id,
        resolved.brandId,
        new Date(),
      );
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, resolved.brandId);
      if (selectedCard?.savedPaymentMethodId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wiez-payment-methods-' + userId}))`;
        if (
          !(await tx.savedPaymentMethod.findFirst({
            where: {
              id: selectedCard.savedPaymentMethodId,
              buyerId: userId,
              status: 'ACTIVE',
            },
            select: { id: true },
          }))
        )
          throw new ConflictException(
            'This saved card changed. Refresh payment methods.',
          );
      }
      const now = new Date();
      const quote = await this.quote(tx, resolved.brandId, dto.tierKey, now);
      if (
        dto.expectedAmountNgn !== undefined &&
        quote.amountNgn > dto.expectedAmountNgn
      )
        throw new ConflictException(
          'The subscription quote changed. Review the updated amount before confirming payment.',
        );
      await this.legal.recordAcceptedDocuments({
        userId,
        requiredKeys: REQUIRED_TERMS,
        acceptances: REQUIRED_TERMS.map((documentKey) => ({
          documentKey,
          version: LEGAL_VERSION,
        })),
        source: LegalAcceptanceSource.CHECKOUT,
        surface: 'brand-subscription',
        accountType: UserType.BRAND,
        req,
        tx,
        metadata: {
          recurringConsent: true,
          brandId: resolved.brandId,
          tierKey: dto.tierKey,
          amountNgn: quote.amountNgn,
          policyVersion: LEGAL_VERSION,
        },
      });
      if (quote.kind === 'UNCHANGED')
        return { action: 'UNCHANGED' as const, quote, invoice: null };
      if (quote.kind === 'DOWNGRADE') {
        await tx.brandSubscription.update({
          where: { id: quote.current!.id },
          data: { scheduledTierKey: dto.tierKey },
        });
        await this.notifyBilling(
          tx,
          resolved.brandId,
          `downgrade-${quote.current!.id}-${dto.tierKey}-${quote.current!.currentPeriodEnd.toISOString()}`,
          'Subscription downgrade scheduled',
          `Your ${dto.tierKey} subscription starts at the next renewal. Your current paid period is not refunded. Review the Lagos billing date and amount in Studio billing.`,
        );
        return { action: 'SCHEDULED_DOWNGRADE' as const, quote, invoice: null };
      }
      // A current-period recovery is the same agreement and invoice, not a new price.
      const recovering =
        quote.current?.status === 'PAST_DUE' &&
        quote.current.tierKey === dto.tierKey &&
        now <= recoveryDeadline(quote.current.currentPeriodEnd);
      if (recovering) {
        const invoice = await tx.brandSubscriptionInvoice.findUnique({
          where: {
            subscriptionId_periodStart: {
              subscriptionId: quote.current!.id,
              periodStart: quote.current!.currentPeriodEnd,
            },
          },
        });
        if (invoice && invoice.status !== 'PAID') {
          return { action: 'PAYMENT_REQUIRED' as const, quote, invoice };
        }
      }
      const existing = await tx.brandSubscriptionInvoice.findFirst({
        where: {
          subscription: {
            brandId: resolved.brandId,
            tierKey: dto.tierKey,
            status: 'PENDING',
          },
          status: {
            in: [
              'PENDING',
              'PROCESSING',
              'FAILED',
              'ACTION_REQUIRED',
              'HOSTED_INITIALIZING',
            ],
          },
          purpose: quote.kind === 'UPGRADE' ? 'SWITCH' : 'INITIAL',
          previousSubscriptionId: quote.current?.id ?? null,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing && existing.periodEnd > now)
        return {
          action: 'PAYMENT_REQUIRED' as const,
          quote,
          invoice: existing,
        };
      const tier = await tx.subscriptionTier.findUniqueOrThrow({
        where: { key: dto.tierKey },
      });
      const subscription = await tx.brandSubscription.create({
        data: {
          brandId: resolved.brandId,
          tierKey: dto.tierKey,
          priceSnapshotNgn: tier.monthlyPriceNgn,
          status: 'PENDING',
          currentPeriodStart:
            quote.kind === 'UPGRADE'
              ? quote.current!.currentPeriodStart
              : quote.effectiveAt,
          currentPeriodEnd: quote.periodEnd,
          billingAnchorDay:
            quote.current?.billingAnchorDay ?? billingAnchorDay(now),
          recurringConsentAt: now,
          recurringPolicyVersion: LEGAL_VERSION,
          providerCustomerEmail:
            selectedCard?.authorizationEmail ?? owner.email,
          savedPaymentMethodId:
            selectedCard?.savedPaymentMethodId ??
            (quote.kind === 'UPGRADE' && quote.amountNgn === 0
              ? quote.current?.savedPaymentMethodId
              : null),
          ...(quote.kind === 'UPGRADE' && quote.amountNgn === 0
            ? {
                providerAuthorizationCode: selectedCard
                  ? encryptSubscriptionAuthorization(
                      selectedCard.authorizationCode,
                      resolved.brandId,
                    )
                  : quote.current?.providerAuthorizationCode,
                providerAuthorizationJson:
                  quote.current?.providerAuthorizationJson ?? Prisma.JsonNull,
                providerCustomerEmail:
                  selectedCard?.authorizationEmail ??
                  quote.current?.providerCustomerEmail ??
                  owner.email,
              }
            : {}),
        },
      });
      const invoice = await tx.brandSubscriptionInvoice.create({
        data: {
          subscriptionId: subscription.id,
          reference: `wzsub-${randomUUID()}`,
          payerEmail: selectedCard?.authorizationEmail ?? owner.email,
          amount: quote.amountNgn,
          currency: 'NGN',
          periodStart: quote.effectiveAt,
          periodEnd: quote.periodEnd,
          purpose: quote.kind === 'UPGRADE' ? 'SWITCH' : 'INITIAL',
          previousSubscriptionId: quote.current?.id ?? null,
        },
      });
      return { action: 'PAYMENT_REQUIRED' as const, quote, invoice };
    });
    if (!prepared.invoice)
      return {
        action: prepared.action,
        amountNgn: 0,
        effectiveAt: prepared.quote.effectiveAt,
        subscription: (await this.getForOwner(userId, resolved.brandId))
          .subscription,
      };
    const invoice = prepared.invoice;
    if (Number(invoice.amount) === 0) {
      await this.applyPayment(invoice.id, {
        reference: invoice.reference,
        status: 'success',
        amount: 0,
        currency: 'NGN',
        customer: { email: owner.email },
        paid_at: new Date().toISOString(),
      });
      return {
        action: 'UPGRADED',
        amountNgn: 0,
        effectiveAt: prepared.quote.effectiveAt,
        subscription: (await this.getForOwner(userId, resolved.brandId))
          .subscription,
      };
    }
    const hosted = await this.prepareHostedPayment(
      invoice.id,
      selectedCard?.authorizationEmail ?? owner.email,
    );
    if (hosted.authorizationUrl)
      return {
        action: prepared.action,
        reference: hosted.reference,
        authorizationUrl: hosted.authorizationUrl,
        providerAccessCode: hosted.providerAccessCode,
        amountNgn: Number(invoice.amount),
        effectiveAt: invoice.periodStart,
      };
    if (selectedCard) {
      if (
        hosted.email.toLowerCase() !==
        selectedCard.authorizationEmail.toLowerCase()
      )
        throw new ConflictException(
          'The existing payment uses another billing identity. Verify it before creating another payment.',
        );
      try {
        const charge = await this.paystack.charge(
          hosted.reference,
          Math.round(Number(invoice.amount) * 100),
          selectedCard.authorizationCode,
          selectedCard.authorizationEmail,
        );
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: {
            status: 'PROCESSING',
            lockedAt: null,
            authorizationUrl: charge?.authorization_url ?? null,
            providerAccessCode: charge?.access_code ?? null,
            nextAttemptAt: new Date(Date.now() + 5 * 60_000),
          },
        });
        const result = await this.verifyForOwner(
          userId,
          resolved.brandId,
          hosted.reference,
        );
        return {
          action: 'PAYMENT_SUBMITTED',
          status: result.status,
          reference: hosted.reference,
          authorizationUrl: charge?.authorization_url,
          providerAccessCode: charge?.access_code,
          amountNgn: Number(invoice.amount),
          effectiveAt: invoice.periodStart,
        };
      } catch (error) {
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: {
            status: 'ACTION_REQUIRED',
            lockedAt: null,
            nextAttemptAt: new Date(Date.now() + 5 * 60_000),
            lastError:
              'Saved-card payment requires verification before another charge.',
          },
        });
        throw error;
      }
    }
    let initialized: Awaited<
      ReturnType<SubscriptionPaystackService['initialize']>
    >;
    try {
      initialized = await this.paystack.initialize(
        hosted.reference,
        Math.round(Number(invoice.amount) * 100),
        hosted.email,
        callbackUrl,
      );
    } catch (error) {
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
        data: {
          status: 'FAILED',
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + 15 * 60_000),
          lastError:
            'Hosted payment initialization is uncertain; verify the existing reference before another payment.',
        },
      });
      throw error;
    }
    if (
      !initialized ||
      initialized.reference !== hosted.reference ||
      !initialized.authorization_url ||
      !initialized.access_code
    )
      throw new BadRequestException(
        'Subscription payment initialization could not be confirmed.',
      );
    await this.prisma.brandSubscriptionInvoice.updateMany({
      where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
      data: {
        status: 'PENDING',
        lockedAt: null,
        authorizationUrl: initialized.authorization_url,
        providerAccessCode: initialized.access_code,
        nextAttemptAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    return {
      action: prepared.action,
      reference: hosted.reference,
      authorizationUrl: initialized.authorization_url,
      providerAccessCode: initialized.access_code,
      amountNgn: Number(invoice.amount),
      effectiveAt: invoice.periodStart,
    };
  }

  private invoiceReference(reference: string) {
    return reference.replace(/(?:-a[1-4]|-h[a-f0-9-]{36})$/, '');
  }

  private paymentIdentities(value: unknown): Record<string, { email: string }> {
    const result: Record<string, { email: string }> = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return result;
    for (const [reference, identity] of Object.entries(value)) {
      if (
        identity &&
        typeof identity === 'object' &&
        typeof identity.email === 'string'
      )
        result[reference] = { email: identity.email };
    }
    return result;
  }

  private paymentEmail(
    invoice: SubscriptionVerificationInvoice,
    reference: string,
  ) {
    return (
      this.paymentIdentities(invoice.paymentIdentityJson)[reference]?.email ??
      invoice.payerEmail ??
      invoice.subscription.providerCustomerEmail
    );
  }

  private paymentReferences(invoice: BrandSubscriptionInvoice): string[] {
    return [
      ...new Set([
        invoice.reference,
        ...Array.from(
          { length: Math.min(4, invoice.attemptCount) },
          (_, index) =>
            subscriptionAttemptReference(invoice.reference, index + 1),
        ),
        ...(invoice.hostedAttemptReferences ?? []),
        ...(invoice.hostedReference ? [invoice.hostedReference] : []),
      ]),
    ];
  }

  private async prepareHostedPayment(id: string, fallbackEmail: string) {
    const invoice = await loadSubscriptionVerificationInvoice(this.prisma, {
      id,
    });
    if (!invoice)
      throw new NotFoundException('Subscription payment not found.');
    if (
      invoice.lockedAt &&
      invoice.lockedAt.getTime() > Date.now() - 10 * 60_000
    )
      throw new ConflictException(
        'Another billing request is being reconciled. Refresh its status before opening a payment.',
      );
    const statuses = new Map<string, string>();
    const recordedCaptures = await this.recordedInvoiceCaptures(invoice);
    for (const reference of this.paymentReferences(invoice)) {
      const status = await this.verifyInvoice(
        invoice,
        reference,
        recordedCaptures,
      );
      statuses.set(reference, status);
      if (status === 'PAID' || status === 'PAID_REVIEW')
        throw new ConflictException(
          'A payment has already been received for this invoice. Refresh billing to see its result.',
        );
      if (status === 'PENDING') {
        if (
          invoice.authorizationUrl &&
          (reference === invoice.hostedReference ||
            (!invoice.hostedReference && reference === invoice.reference))
        )
          return {
            reference,
            authorizationUrl: invoice.authorizationUrl,
            providerAccessCode: invoice.providerAccessCode,
            email: this.paymentEmail(invoice, reference) ?? fallbackEmail,
          };
        throw new ConflictException(
          'An earlier payment is still pending. Verify that payment before starting another one.',
        );
      }
      if (status === 'NOT_FOUND' && /-a[1-4]$/.test(reference))
        throw new ConflictException(
          'The status of an earlier submitted payment is uncertain. Billing support must reconcile it before another charge.',
        );
    }
    const reference =
      invoice.hostedReference &&
      statuses.get(invoice.hostedReference) === 'NOT_FOUND'
        ? invoice.hostedReference
        : statuses.get(invoice.reference) === 'NOT_FOUND' &&
            !(invoice.hostedAttemptReferences ?? []).includes(invoice.reference)
          ? invoice.reference
          : `${invoice.reference}-h${randomUUID()}`;
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, invoice.subscription.brandId);
      const latest = await tx.brandSubscriptionInvoice.findUniqueOrThrow({
        where: { id },
      });
      if (
        [
          'PAID',
          'PAID_REVIEW',
          'PAYMENT_REVIEW',
          'CANCELLED',
          'EXPIRED',
        ].includes(latest.status) ||
        latest.attemptCount !== invoice.attemptCount ||
        latest.hostedReference !== invoice.hostedReference ||
        (latest.lockedAt &&
          latest.lockedAt.getTime() > Date.now() - 10 * 60_000)
      )
        throw new ConflictException(
          'Billing changed while the payment was checked. Refresh and review the current status.',
        );
      const history = latest.hostedAttemptReferences ?? [];
      const identities = this.paymentIdentities(latest.paymentIdentityJson);
      const email =
        identities[reference]?.email ??
        this.paymentEmail(invoice, reference) ??
        fallbackEmail;
      identities[reference] = { email };
      if (!history.includes(reference) && history.length >= 20)
        throw new ConflictException(
          'This invoice needs billing support after repeated payment attempts. No new charge was initiated.',
        );
      await tx.brandSubscriptionInvoice.update({
        where: { id },
        data: {
          hostedReference: reference,
          hostedAttemptReferences: history.includes(reference)
            ? history
            : [...history, reference],
          status: 'HOSTED_INITIALIZING',
          paymentIdentityJson: identities,
          lockedAt: new Date(),
          nextAttemptAt: new Date(Date.now() + 10 * 60_000),
          authorizationUrl: null,
          providerAccessCode: null,
        },
      });
      if (!invoice.subscription.providerCustomerEmail)
        await tx.brandSubscription.update({
          where: { id: invoice.subscriptionId },
          data: { providerCustomerEmail: fallbackEmail },
        });
      return {
        reference,
        authorizationUrl: null,
        providerAccessCode: null,
        email,
      };
    });
  }

  async verifyForOwner(userId: string, brandId: string, reference: string) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    const invoice = await loadSubscriptionVerificationInvoice(this.prisma, {
      reference: this.invoiceReference(reference),
      brandId: resolved.brandId,
    });
    if (!invoice)
      throw new NotFoundException('Subscription payment not found.');
    let pending = false;
    const recordedCaptures = await this.recordedInvoiceCaptures(invoice);
    for (const candidate of this.paymentReferences(invoice)) {
      const result = await this.verifyInvoice(
        invoice,
        candidate,
        recordedCaptures,
      );
      pending ||= result === 'PENDING';
    }
    if (pending)
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: {
          id: invoice.id,
          status: { notIn: ['PAID', 'PAID_REVIEW', 'PAYMENT_REVIEW'] },
        },
        data: { status: 'ACTION_REQUIRED' },
      });
    const refreshed =
      await this.prisma.brandSubscriptionInvoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
    return {
      status: refreshed.status,
      paid: refreshed.status === 'PAID',
      subscription: (await this.getForOwner(userId, resolved.brandId))
        .subscription,
    };
  }

  /** Called only after the central webhook signature gate; still verifies provider facts. */
  async handleProviderCharge(reference: string): Promise<boolean> {
    if (!/^wzsub-[a-f0-9-]+(?:-a[1-4]|-h[a-f0-9-]{36})?$/.test(reference))
      return false;
    const invoice = await loadSubscriptionVerificationInvoice(this.prisma, {
      reference: this.invoiceReference(reference),
    });
    if (!invoice) return false;
    await this.verifyInvoice(invoice, reference);
    return true;
  }

  private async recordedInvoiceCaptures(invoice: BrandSubscriptionInvoice) {
    if (!['PAID', 'PAID_REVIEW'].includes(invoice.status)) return undefined;
    const captures = await this.prisma.brandSubscriptionPaymentCapture.findMany(
      {
        where: {
          invoiceId: invoice.id,
          reference: { in: this.paymentReferences(invoice) },
        },
        select: { reference: true, status: true },
      },
    );
    return new Map(
      captures.map((capture) => [capture.reference, capture.status]),
    );
  }

  private async verifyInvoice(
    invoice: SubscriptionVerificationInvoice,
    reference: string,
    recordedCaptures?: ReadonlyMap<string, string>,
  ): Promise<string> {
    if (invoice.status === 'PAID' || invoice.status === 'PAID_REVIEW') {
      const recordedStatus = recordedCaptures
        ? recordedCaptures.get(reference)
        : (
            await this.prisma.brandSubscriptionPaymentCapture.findUnique({
              where: { reference },
              select: { status: true },
            })
          )?.status;
      if (recordedStatus)
        return recordedStatus === 'APPLIED' ? 'PAID' : 'PAID_REVIEW';
    }
    const result = await this.paystack.verify(reference);
    if (!result) return 'NOT_FOUND';
    if (
      result.reference !== reference ||
      Math.round(Number(invoice.amount) * 100) !== Number(result.amount) ||
      result.currency !== invoice.currency ||
      result.customer?.email?.toLowerCase() !==
        this.paymentEmail(invoice, reference)?.toLowerCase()
    ) {
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
        data: {
          status: 'PAYMENT_REVIEW',
          lockedAt: null,
          lastError:
            'Provider amount, currency, customer or reference mismatch. Billing review required.',
          nextAttemptAt: null,
        },
      });
      throw new ConflictException(
        'This payment needs billing review before subscription access can change.',
      );
    }
    if (result.status === 'success')
      return this.applyPayment(invoice.id, result);
    if (['failed', 'abandoned', 'reversed'].includes(result.status)) {
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: { id: invoice.id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
        data: {
          status: 'FAILED',
          lastError:
            'The provider did not confirm payment. Existing entitlement is unchanged.',
        },
      });
      return 'FAILED';
    }
    return 'PENDING';
  }

  private async applyPayment(
    invoiceId: string,
    provider: SubscriptionProviderTransaction,
  ) {
    const initial = await loadSubscriptionVerificationInvoice(this.prisma, {
      id: invoiceId,
    });
    if (!initial)
      throw new NotFoundException('Subscription payment not found.');
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, initial.subscription.brandId);
      const invoice = await tx.brandSubscriptionInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { subscription: true },
      });
      const paidAt = provider.paid_at ? new Date(provider.paid_at) : new Date();
      if (!Number.isFinite(paidAt.getTime()))
        throw new ConflictException(
          'Payment confirmation needs a valid provider payment timestamp.',
        );
      const priorCapture = await tx.brandSubscriptionPaymentCapture.findUnique({
        where: { reference: provider.reference },
      });
      if (priorCapture)
        return priorCapture.status === 'APPLIED' ? 'PAID' : 'PAID_REVIEW';
      const capture = await tx.brandSubscriptionPaymentCapture.create({
        data: {
          invoiceId,
          reference: provider.reference,
          providerTransactionId: String(provider.id ?? provider.reference),
          amount: Number(provider.amount) / 100,
          currency: provider.currency,
          paidAt,
        },
      });
      if (invoice.status === 'PAID' || invoice.status === 'PAID_REVIEW') {
        const reason =
          invoice.status === 'PAID' ? 'DUPLICATE_CAPTURE' : 'UNAPPLIED_CAPTURE';
        await tx.brandSubscriptionPaymentCapture.update({
          where: { id: capture.id },
          data: {
            status: 'COMPENSATION_REQUIRED',
            reason,
            nextAttemptAt: new Date(),
          },
        });
        await this.compensationAttention(
          tx,
          invoice,
          provider.reference,
          reason,
        );
        return 'PAID_REVIEW';
      }
      const current = await this.current(tx, invoice.subscription.brandId);
      const unexpectedAgreement =
        current &&
        current.id !== invoice.subscriptionId &&
        current.id !== invoice.previousSubscriptionId;
      const lateSwitch =
        invoice.purpose === 'SWITCH' && paidAt >= invoice.periodEnd;
      const lateInitial =
        invoice.purpose === 'INITIAL' && paidAt >= invoice.periodEnd;
      const lateRenewal =
        invoice.purpose === 'RENEWAL' &&
        paidAt > recoveryDeadline(invoice.periodStart);
      const sourceAgreement =
        invoice.purpose === 'RENEWAL'
          ? await tx.brandSubscription.findUnique({
              where: {
                id: invoice.previousSubscriptionId ?? invoice.subscriptionId,
              },
              select: { cancelRequestedAt: true },
            })
          : null;
      const cancelledRenewal =
        sourceAgreement?.cancelRequestedAt &&
        paidAt >= sourceAgreement.cancelRequestedAt;
      if (
        unexpectedAgreement ||
        lateSwitch ||
        lateInitial ||
        lateRenewal ||
        cancelledRenewal
      ) {
        await tx.brandSubscriptionInvoice.update({
          where: { id: invoice.id },
          data: {
            status: 'PAID_REVIEW',
            paidAt,
            providerTransactionId: String(provider.id ?? provider.reference),
            lockedAt: null,
            nextAttemptAt: null,
            lastError:
              'Captured payment requires compensation review; entitlement has not changed.',
          },
        });
        await tx.brandSubscriptionPaymentCapture.update({
          where: { id: capture.id },
          data: {
            status: 'COMPENSATION_REQUIRED',
            reason: unexpectedAgreement
              ? 'SUPERSEDED_AGREEMENT'
              : cancelledRenewal
                ? 'CANCELLED_RENEWAL_CAPTURE'
                : 'LATE_CAPTURE',
            nextAttemptAt: new Date(),
          },
        });
        await this.compensationAttention(
          tx,
          invoice,
          provider.reference,
          'Captured payment cannot activate the quoted entitlement; a full refund is required.',
        );
        return 'PAID_REVIEW';
      }
      const initialPeriod = invoice.purpose === 'INITIAL';
      const periodStart = initialPeriod
        ? paidAt
        : invoice.purpose === 'SWITCH'
          ? invoice.subscription.currentPeriodStart
          : invoice.periodStart;
      const anchor = initialPeriod
        ? billingAnchorDay(paidAt)
        : (invoice.subscription.billingAnchorDay ??
          billingAnchorDay(invoice.subscription.currentPeriodStart));
      const periodEnd = initialPeriod
        ? nextBillingAnniversary(paidAt, anchor)
        : invoice.periodEnd;
      // Cancel the previous row before activating its replacement, under the same lock.
      if (
        invoice.previousSubscriptionId &&
        invoice.previousSubscriptionId !== invoice.subscriptionId
      )
        await tx.brandSubscription.update({
          where: { id: invoice.previousSubscriptionId },
          data: { status: 'CANCELLED', scheduledTierKey: null },
        });
      const authorization = provider.authorization;
      const reusable =
        authorization?.reusable === true &&
        Boolean(authorization.authorization_code);
      const encryptedAuthorization = reusable
        ? encryptSubscriptionAuthorization(
            authorization!.authorization_code!,
            invoice.subscription.brandId,
          )
        : null;
      const authorizationContext = authorization
        ? Object.fromEntries(
            Object.entries(authorization).filter(
              ([name]) => name !== 'authorization_code',
            ),
          )
        : null;
      const billingOwner =
        reusable && this.payments
          ? await tx.brand.findUnique({
              where: { id: invoice.subscription.brandId },
              select: { ownerId: true },
            })
          : null;
      const savedCard = billingOwner
        ? await this.payments.saveVerifiedSubscriptionCard(
            tx,
            billingOwner.ownerId,
            authorization!,
            provider.customer!.email,
          )
        : null;
      await tx.brandSubscription.update({
        where: { id: invoice.subscriptionId },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          billingAnchorDay: anchor,
          recoveryUntil: null,
          ...(savedCard ? { savedPaymentMethodId: savedCard.id } : {}),
          ...(encryptedAuthorization
            ? {
                providerAuthorizationCode: encryptedAuthorization,
                providerAuthorizationJson:
                  authorizationContext as Prisma.InputJsonValue,
                providerCustomerEmail: provider.customer!.email,
              }
            : {}),
        },
      });
      await tx.brandSubscriptionInvoice.update({
        where: { id: invoice.id },
        data: {
          status: 'PAID',
          paidAt,
          periodStart,
          periodEnd,
          providerTransactionId: String(provider.id ?? provider.reference),
          lockedAt: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      await this.notifyBilling(
        tx,
        invoice.subscription.brandId,
        `paid-${invoice.id}`,
        'Subscription payment confirmed',
        `Your ${invoice.subscription.tierKey} subscription payment of NGN ${Number(invoice.amount).toFixed(2)} is confirmed. View your period, renewal date, price and receipt in Studio billing.`,
      );
      return 'PAID';
    });
  }

  async cancelRenewal(userId: string, brandId: string) {
    const resolved = await this.access.assertBrandOwnerAndResolve(
      userId,
      brandId,
    );
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, resolved.brandId);
      const current = await this.current(tx, resolved.brandId);
      if (!current)
        throw new NotFoundException('No active subscription was found.');
      await tx.brandSubscription.update({
        where: { id: current.id },
        data: {
          cancelAtPeriodEnd: true,
          cancelRequestedAt: current.cancelRequestedAt ?? new Date(),
          scheduledTierKey: null,
        },
      });
      await this.notifyBilling(
        tx,
        resolved.brandId,
        `cancel-${current.id}-${current.currentPeriodEnd.toISOString()}`,
        'Subscription renewal cancelled',
        'Future subscription renewal is cancelled. Access continues through the current paid-period end; already-paid shopper orders continue.',
      );
      // An already submitted provider transaction is reconciled, never hidden by deletion.
      await tx.brandSubscriptionInvoice.updateMany({
        where: {
          subscriptionId: current.id,
          status: { in: ['PENDING', 'FAILED'] },
          lockedAt: null,
          purpose: 'RENEWAL',
          attemptCount: 0,
        },
        data: { status: 'CANCELLED', nextAttemptAt: null },
      });
    });
    return this.getForOwner(userId, resolved.brandId);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processBilling(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.brandSubscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'PAST_DUE'] },
        currentPeriodEnd: { lte: now },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: 50,
      select: { id: true, brandId: true },
    });
    for (const row of expired) {
      try {
        await this.prepareRenewal(row.id, row.brandId, now);
      } catch {
        this.logger.warn(
          `Subscription renewal preparation requires attention subscription=${row.id}`,
        );
      }
    }
    const due = await this.prisma.brandSubscriptionInvoice.findMany({
      where: {
        status: {
          in: [
            'PENDING',
            'FAILED',
            'PROCESSING',
            'ACTION_REQUIRED',
            'HOSTED_INITIALIZING',
          ],
        },
        nextAttemptAt: { lte: now },
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 30,
      select: { id: true },
    });
    for (const row of due) {
      try {
        await this.processInvoice(row.id, now);
      } catch {
        this.logger.warn(
          `Subscription invoice reconciliation requires attention invoice=${row.id}`,
        );
      }
    }
    await this.processCompensations(now);
  }

  private async prepareRenewal(id: string, brandId: string, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, brandId);
      const context = await loadSubscriptionRenewalContext(tx, id);
      if (!context) throw new NotFoundException('Subscription not found.');
      const { subscription: current, targetTier } = context;
      if (
        !['ACTIVE', 'PAST_DUE'].includes(current.status) ||
        current.currentPeriodEnd > now
      )
        return;
      if (
        current.cancelAtPeriodEnd ||
        now > recoveryDeadline(current.currentPeriodEnd)
      ) {
        await tx.brandSubscription.update({
          where: { id },
          data: { status: 'CANCELLED' },
        });
        await this.notifyBilling(
          tx,
          brandId,
          `ended-${id}-${current.currentPeriodEnd.toISOString()}`,
          'Subscription paid period ended',
          'Your paid subscription period has ended and new custom-order intake is paused. Existing paid shopper obligations continue. A new agreement uses current pricing after the recovery window.',
        );
        return;
      }
      await tx.brandSubscription.update({
        where: { id },
        data: {
          status: 'PAST_DUE',
          recoveryUntil: recoveryDeadline(current.currentPeriodEnd),
        },
      });
      await this.notifyBilling(
        tx,
        brandId,
        `past-due-${id}-${current.currentPeriodEnd.toISOString()}`,
        'Subscription renewal needs attention',
        'Your paid period has ended. New custom-order intake is paused while your existing paid orders continue. Recover the renewal within seven days at the existing agreed price, or review a new agreement after that window.',
      );
      if (current.scheduledTierKey && !targetTier)
        throw new NotFoundException('Scheduled subscription tier not found.');
      let subscription = current;
      if (targetTier) {
        const pending = await tx.brandSubscription.findFirst({
          where: {
            brandId,
            tierKey: targetTier.key,
            status: 'PENDING',
            currentPeriodStart: current.currentPeriodEnd,
          },
        });
        subscription =
          pending ??
          (await tx.brandSubscription.create({
            data: {
              brandId,
              tierKey: targetTier.key,
              priceSnapshotNgn: targetTier.monthlyPriceNgn,
              status: 'PENDING',
              currentPeriodStart: current.currentPeriodEnd,
              currentPeriodEnd: nextBillingAnniversary(
                current.currentPeriodEnd,
                current.billingAnchorDay ??
                  billingAnchorDay(current.currentPeriodStart),
              ),
              billingAnchorDay: current.billingAnchorDay,
              recurringConsentAt: current.recurringConsentAt,
              recurringPolicyVersion: current.recurringPolicyVersion,
              providerAuthorizationCode: current.providerAuthorizationCode,
              providerAuthorizationJson:
                current.providerAuthorizationJson ?? Prisma.JsonNull,
              providerCustomerEmail: current.providerCustomerEmail,
              savedPaymentMethodId: current.savedPaymentMethodId,
            },
          }));
      }
      const existing = await tx.brandSubscriptionInvoice.findUnique({
        where: {
          subscriptionId_periodStart: {
            subscriptionId: subscription.id,
            periodStart: current.currentPeriodEnd,
          },
        },
      });
      if (!existing)
        await tx.brandSubscriptionInvoice.create({
          data: {
            subscriptionId: subscription.id,
            reference: `wzsub-${randomUUID()}`,
            amount: subscription.priceSnapshotNgn,
            periodStart: current.currentPeriodEnd,
            periodEnd: nextBillingAnniversary(
              current.currentPeriodEnd,
              current.billingAnchorDay ??
                billingAnchorDay(current.currentPeriodStart),
            ),
            purpose: 'RENEWAL',
            payerEmail: subscription.providerCustomerEmail,
            previousSubscriptionId: targetTier ? current.id : null,
            nextAttemptAt: now,
          },
        });
    });
  }

  private async processInvoice(id: string, now: Date) {
    const claimed = await this.prisma.brandSubscriptionInvoice.updateMany({
      where: {
        id,
        status: {
          in: [
            'PENDING',
            'FAILED',
            'PROCESSING',
            'ACTION_REQUIRED',
            'HOSTED_INITIALIZING',
          ],
        },
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
        ],
      },
      data: {
        lockedAt: now,
        nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
      },
    });
    if (!claimed.count) return;
    const invoice = await loadSubscriptionVerificationInvoice(this.prisma, {
      id,
    });
    if (!invoice)
      throw new NotFoundException('Subscription payment not found.');
    try {
      // Check every durably named prior attempt before considering another charge.
      for (const reference of this.paymentReferences(invoice)) {
        const status = await this.verifyInvoice(invoice, reference);
        if (status === 'PAID' || status === 'PAID_REVIEW') return;
        if (
          status === 'PENDING' ||
          (status === 'NOT_FOUND' &&
            (reference === invoice.hostedReference ||
              /-a[1-4]$/.test(reference)))
        ) {
          await this.prisma.brandSubscriptionInvoice.updateMany({
            where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
            data: {
              lockedAt: null,
              status: 'ACTION_REQUIRED',
              nextAttemptAt:
                now > recoveryDeadline(invoice.periodStart)
                  ? null
                  : new Date(now.getTime() + 15 * 60_000),
              lastError:
                status === 'NOT_FOUND'
                  ? 'An earlier payment is uncertain. Reconcile that reference before another debit.'
                  : 'A payment is awaiting provider confirmation or authorization.',
            },
          });
          return;
        }
      }
      if (invoice.purpose !== 'RENEWAL') {
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: {
            lockedAt: null,
            ...(now >= invoice.periodEnd
              ? { status: 'EXPIRED', nextAttemptAt: null }
              : { nextAttemptAt: new Date(now.getTime() + 30 * 60_000) }),
          },
        });
        return;
      }
      const debitContext = await loadSubscriptionDebitContext(
        this.prisma,
        invoice.subscriptionId,
        invoice.previousSubscriptionId,
      );
      if (!debitContext) throw new NotFoundException('Subscription not found.');
      const { subscription, sourceAgreement, linkedCard } = debitContext;
      const authorizationCode = decryptSubscriptionAuthorization(
        subscription.providerAuthorizationCode,
        subscription.brandId,
      );
      if (
        !sourceAgreement ||
        sourceAgreement.cancelAtPeriodEnd ||
        sourceAgreement.status === 'CANCELLED' ||
        subscription.cancelAtPeriodEnd ||
        !subscription.recurringConsentAt ||
        !authorizationCode ||
        (subscription.savedPaymentMethodId && !linkedCard) ||
        !subscription.providerCustomerEmail ||
        now > recoveryDeadline(invoice.periodStart)
      ) {
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: {
            lockedAt: null,
            status: 'ACTION_REQUIRED',
            nextAttemptAt: null,
            lastError:
              'Renewal requires payment-method authorization or a new subscription agreement.',
          },
        });
        return;
      }
      const due = renewalAttemptAt(invoice.periodStart, invoice.attemptCount);
      if (!due || due > now) {
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: { lockedAt: null, nextAttemptAt: due },
        });
        return;
      }
      const count = invoice.attemptCount + 1;
      const reference = subscriptionAttemptReference(invoice.reference, count);
      const identities = this.paymentIdentities(invoice.paymentIdentityJson);
      identities[reference] = { email: subscription.providerCustomerEmail };
      await this.prisma.brandSubscriptionInvoice.update({
        where: { id },
        data: {
          attemptCount: count,
          status: 'PROCESSING',
          paymentIdentityJson: identities,
        },
      });
      invoice.paymentIdentityJson = identities;
      const charge = await this.paystack.charge(
        reference,
        Math.round(Number(invoice.amount) * 100),
        authorizationCode,
        subscription.providerCustomerEmail,
      );
      if (charge?.paused && charge.authorization_url)
        await this.prisma.brandSubscriptionInvoice.updateMany({
          where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
          data: {
            hostedReference: reference,
            authorizationUrl: charge.authorization_url,
            providerAccessCode: charge.access_code ?? null,
          },
        });
      const status = await this.verifyInvoice(invoice, reference);
      if (status === 'PAID' || status === 'PAID_REVIEW') return;
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: { id, status: { notIn: ['PAID', 'PAID_REVIEW'] } },
        data: {
          lockedAt: null,
          status: status === 'PENDING' ? 'ACTION_REQUIRED' : 'FAILED',
          nextAttemptAt:
            status === 'PENDING'
              ? new Date(now.getTime() + 15 * 60_000)
              : renewalAttemptAt(invoice.periodStart, count),
          lastError: 'Renewal payment has not been confirmed.',
        },
      });
      await this.prisma.$transaction((tx) =>
        this.notifyBilling(
          tx,
          subscription.brandId,
          `retry-${id}-${count}`,
          'Subscription payment not confirmed',
          'Your renewal payment is not yet confirmed. New intake remains paused; review payment status and any required authorization in Studio billing.',
        ),
      );
    } catch {
      await this.prisma.brandSubscriptionInvoice.updateMany({
        where: {
          id,
          status: { notIn: ['PAID', 'PAID_REVIEW', 'PAYMENT_REVIEW'] },
        },
        data: {
          lockedAt: null,
          nextAttemptAt: new Date(now.getTime() + 15 * 60_000),
          lastError:
            'Provider response is uncertain; reconcile the existing references before another charge.',
        },
      });
    }
  }

  /** Submission uncertainty is escalated, never followed by a blind second refund. */
  private async processCompensations(now: Date) {
    const rows = await this.prisma.brandSubscriptionPaymentCapture.findMany({
      where: {
        status: {
          in: [
            'COMPENSATION_REQUIRED',
            'REFUND_PROCESSING',
            'REFUND_SUBMITTING',
          ],
        },
        nextAttemptAt: { lte: now },
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 10,
      select: { id: true },
    });
    for (const row of rows) {
      const claimed =
        await this.prisma.brandSubscriptionPaymentCapture.updateMany({
          where: {
            id: row.id,
            status: {
              in: [
                'COMPENSATION_REQUIRED',
                'REFUND_PROCESSING',
                'REFUND_SUBMITTING',
              ],
            },
            OR: [
              { lockedAt: null },
              { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
            ],
          },
          data: {
            lockedAt: now,
            nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
          },
        });
      if (!claimed.count) continue;
      const capture = await this.loadCompensationCapture(this.prisma, row.id);
      try {
        if (
          capture.status === 'REFUND_SUBMITTING' &&
          !capture.providerRefundId
        ) {
          await this.refundNeedsAttention(
            capture.id,
            'A refund submission was interrupted. Verify the existing provider refund before retrying.',
          );
          continue;
        }
        if (Number(capture.amount) === 0) {
          await this.prisma.brandSubscriptionPaymentCapture.update({
            where: { id: capture.id },
            data: {
              status: 'REFUNDED',
              refundedAt: now,
              lockedAt: null,
              nextAttemptAt: null,
            },
          });
          continue;
        }
        let refund;
        if (capture.providerRefundId)
          refund = await this.paystack.verifyRefund(capture.providerRefundId);
        else {
          await this.prisma.brandSubscriptionPaymentCapture.update({
            where: { id: capture.id },
            data: { status: 'REFUND_SUBMITTING', attempts: { increment: 1 } },
          });
          refund = await this.paystack.refund(
            capture.reference,
            Math.round(Number(capture.amount) * 100),
          );
        }
        if (!refund?.id) throw new Error('Provider refund result is missing.');
        const transactionMatches =
          typeof refund.transaction === 'object'
            ? refund.transaction.reference === capture.reference ||
              String(refund.transaction.id) === capture.providerTransactionId
            : String(refund.transaction) === capture.providerTransactionId;
        if (
          !transactionMatches ||
          Number(refund.amount) !== Math.round(Number(capture.amount) * 100) ||
          refund.currency !== capture.currency
        )
          throw new Error(
            'Provider refund identity or amount does not match the capture.',
          );
        const processed = refund.status === 'processed';
        const attention = ['failed', 'needs-attention'].includes(refund.status);
        await this.prisma.$transaction(async (tx) => {
          await tx.brandSubscriptionPaymentCapture.update({
            where: { id: capture.id },
            data: {
              providerRefundId: String(refund.id),
              status: processed
                ? 'REFUNDED'
                : attention
                  ? 'NEEDS_ATTENTION'
                  : 'REFUND_PROCESSING',
              refundedAt: processed ? now : null,
              lockedAt: null,
              nextAttemptAt:
                processed || attention
                  ? null
                  : new Date(now.getTime() + 15 * 60_000),
              lastError: attention
                ? 'The provider refund needs billing support attention.'
                : null,
            },
          });
          if (processed) {
            await this.notifyBilling(
              tx,
              capture.invoice.subscription.brandId,
              `refunded-${capture.reference}`,
              'Subscription refund processed',
              `The provider has processed your subscription compensation of NGN ${Number(capture.amount).toFixed(2)}. Your bank may take additional business days to show the credit.`,
            );
            await tx.operationalAlert.updateMany({
              where: {
                dedupeKey: `subscription-capture-${capture.reference}`,
                status: 'OPEN',
              },
              data: { status: 'RESOLVED', resolvedAt: now },
            });
          }
          if (attention)
            await this.compensationAttention(
              tx,
              capture.invoice,
              capture.reference,
              'The provider refund needs billing support attention.',
            );
        });
      } catch {
        const refreshed =
          await this.prisma.brandSubscriptionPaymentCapture.findUniqueOrThrow({
            where: { id: capture.id },
            select: { providerRefundId: true },
          });
        if (!refreshed.providerRefundId)
          await this.refundNeedsAttention(
            capture.id,
            'Provider refund submission could not be confirmed. Reconcile the original request before retrying.',
          );
        else
          await this.prisma.brandSubscriptionPaymentCapture.update({
            where: { id: capture.id },
            data: {
              status: 'REFUND_PROCESSING',
              lockedAt: null,
              nextAttemptAt: new Date(now.getTime() + 15 * 60_000),
              lastError: 'Provider refund status is temporarily unavailable.',
            },
          });
      }
    }
  }

  private async refundNeedsAttention(id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.brandSubscriptionPaymentCapture.update({
        where: { id },
        data: {
          status: 'NEEDS_ATTENTION',
          lockedAt: null,
          nextAttemptAt: null,
          lastError: reason,
        },
      });
      const capture = await this.loadCompensationCapture(tx, id);
      await this.compensationAttention(
        tx,
        capture.invoice,
        capture.reference,
        reason,
      );
    });
  }

  private async loadCompensationCapture(
    db: PrismaService | Prisma.TransactionClient,
    id: string,
  ) {
    const [row] = await db.$queryRaw<
      Array<{
        id: string;
        reference: string;
        status: string;
        amount: Prisma.Decimal;
        currency: string;
        providerRefundId: string | null;
        providerTransactionId: string | null;
        invoiceId: string;
        invoiceAmount: Prisma.Decimal;
        invoiceCurrency: string;
        brandId: string;
      }>
    >(Prisma.sql`
      SELECT c.id, c.reference, c.status, c.amount, c.currency,
        c."providerRefundId", c."providerTransactionId", i.id AS "invoiceId",
        i.amount AS "invoiceAmount", i.currency AS "invoiceCurrency", s."brandId"
      FROM "BrandSubscriptionPaymentCapture" c
      JOIN "BrandSubscriptionInvoice" i ON i.id = c."invoiceId"
      JOIN "BrandSubscription" s ON s.id = i."subscriptionId"
      WHERE c.id = ${id}::uuid
    `);
    if (!row) throw new NotFoundException('Subscription capture not found');
    return {
      ...row,
      invoice: {
        id: row.invoiceId,
        amount: row.invoiceAmount,
        currency: row.invoiceCurrency,
        subscription: { brandId: row.brandId },
      },
    };
  }

  private assertAdmin(actor: SubscriptionAdminActor, permission: string) {
    if (
      !actor?.id ||
      (actor.role !== Role.SuperAdmin &&
        (actor.role !== Role.Admin || !actor.permissions?.includes(permission)))
    )
      throw new ForbiddenException(
        'You do not have permission to manage subscription compensation.',
      );
  }

  private presentCapture(
    capture: Prisma.BrandSubscriptionPaymentCaptureGetPayload<{
      include: {
        invoice: {
          include: {
            subscription: { include: { brand: { select: { name: true } } } };
          };
        };
      };
    }>,
  ) {
    return {
      id: capture.id,
      invoiceId: capture.invoiceId,
      brandId: capture.invoice.subscription.brandId,
      brandName: capture.invoice.subscription.brand.name,
      reference: capture.reference,
      invoiceReference: capture.invoice.reference,
      amountNgn: Number(capture.amount),
      currency: capture.currency,
      paidAt: capture.paidAt,
      status: capture.status,
      reason: capture.reason,
      providerRefundId: capture.providerRefundId,
      lastError: capture.lastError,
      createdAt: capture.createdAt,
      refundedAt: capture.refundedAt,
      nextAttemptAt: capture.nextAttemptAt,
    };
  }

  async listCompensations(
    actor: SubscriptionAdminActor,
    cursor?: string,
    limit = 25,
  ) {
    this.assertAdmin(actor, ADMIN_PERMISSIONS.PAYOUTS_READ);
    const size = Math.min(50, Math.max(1, limit));
    const rows = await this.prisma.brandSubscriptionPaymentCapture.findMany({
      where: { status: { not: 'APPLIED' } },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      include: {
        invoice: {
          include: {
            subscription: { include: { brand: { select: { name: true } } } },
          },
        },
      },
    });
    return {
      captures: rows
        .slice(0, size)
        .map((capture) => this.presentCapture(capture)),
      nextCursor: rows.length > size ? rows[size - 1].id : null,
      serverNow: new Date().toISOString(),
    };
  }

  async reconcileCompensation(
    actor: SubscriptionAdminActor,
    id: string,
    refundId?: string,
  ) {
    this.assertAdmin(actor, ADMIN_PERMISSIONS.PAYOUTS_PROCESS);
    const capture =
      await this.prisma.brandSubscriptionPaymentCapture.findUnique({
        where: { id },
        include: { invoice: { include: { subscription: true } } },
      });
    if (!capture || capture.status === 'APPLIED')
      throw new NotFoundException('Subscription compensation was not found.');
    const providerRefundId = refundId ?? capture.providerRefundId;
    if (!providerRefundId || !/^\d{1,30}$/.test(providerRefundId))
      throw new BadRequestException(
        'Provide the existing Paystack refund ID. This action verifies it and does not submit another refund.',
      );
    const refund = await this.paystack.verifyRefund(providerRefundId);
    const transactionMatches =
      typeof refund?.transaction === 'object'
        ? refund.transaction.reference === capture.reference ||
          String(refund.transaction.id) === capture.providerTransactionId
        : String(refund?.transaction) === capture.providerTransactionId;
    if (
      !refund ||
      String(refund.id) !== providerRefundId ||
      !transactionMatches ||
      Number(refund.amount) !== Math.round(Number(capture.amount) * 100) ||
      refund.currency !== capture.currency
    )
      throw new ConflictException(
        'The provider refund does not match this capture, amount and currency. No compensation status was changed.',
      );
    const now = new Date();
    const processed = refund.status === 'processed';
    const attention = ['failed', 'needs-attention'].includes(refund.status);
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, capture.invoice.subscription.brandId);
      const latest = await tx.brandSubscriptionPaymentCapture.findUniqueOrThrow(
        { where: { id } },
      );
      if (latest.status === 'REFUNDED') return;
      await tx.brandSubscriptionPaymentCapture.update({
        where: { id },
        data: {
          providerRefundId,
          status: processed
            ? 'REFUNDED'
            : attention
              ? 'NEEDS_ATTENTION'
              : 'REFUND_PROCESSING',
          refundedAt: processed ? now : null,
          lockedAt: null,
          nextAttemptAt:
            processed || attention
              ? null
              : new Date(now.getTime() + 15 * 60_000),
          lastError: attention ? 'Provider refund needs attention.' : null,
        },
      });
      await tx.operationalAlert.updateMany({
        where: { dedupeKey: `subscription-capture-${capture.reference}` },
        data: {
          ...(processed
            ? { status: 'RESOLVED', resolvedAt: now, resolvedBy: actor.id }
            : {}),
          metadata: {
            brandId: capture.invoice.subscription.brandId,
            reference: capture.reference,
            reconciledBy: actor.id,
            reconciledAt: now.toISOString(),
            providerRefundId,
            providerStatus: refund.status,
            amountNgn: Number(capture.amount),
            currency: capture.currency,
          },
        },
      });
      if (processed)
        await this.notifyBilling(
          tx,
          capture.invoice.subscription.brandId,
          `refunded-${capture.reference}`,
          'Subscription refund processed',
          'Your subscription compensation was processed by the payment provider. Your bank may take additional business days to show the credit.',
        );
    });
    const updated =
      await this.prisma.brandSubscriptionPaymentCapture.findUniqueOrThrow({
        where: { id },
        include: {
          invoice: {
            include: {
              subscription: { include: { brand: { select: { name: true } } } },
            },
          },
        },
      });
    return {
      capture: this.presentCapture(updated),
      serverNow: now.toISOString(),
    };
  }
}
