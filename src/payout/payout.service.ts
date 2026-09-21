import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AdminAuditAction,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  EmailPriority,
  LoginCodePurpose,
  PayoutStatus,
  Prisma,
} from '@prisma/client';
import { randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PasswordService } from 'src/auth/helper/password.service';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import { CommissionService } from 'src/finance/commission.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import {
  canonicalUserProfileSelect,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

/** Matches the other email codes on the platform; long enough to arrive, short
 *  enough that a code sitting in an inbox stops being useful quickly. */
const PAYOUT_CODE_TTL_MS = 10 * 60 * 1000;
const PAYOUT_CODE_MAX_ATTEMPTS = 5;
const PAYOUT_CODE_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * One message for every way a code can be wrong: not found, expired, already
 * spent, wrong digits, or bound to a different brand or amount. Naming which
 * of those happened would tell someone probing the endpoint whether a live
 * code exists and what it was issued for.
 */
const PAYOUT_CODE_REJECTED_MESSAGE =
  'That code is not valid or has expired. Request a new payout code.';

export type PayoutChallengeResult = {
  challengeRequired: true;
  amount: number;
  expiresInSeconds: number;
  maxAttempts: number;
  resendAfterSeconds: number;
  emailHint: string;
  message: string;
};

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly commissionService: CommissionService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
    private readonly customOrderFinanceSyncService: CustomOrderFinanceSyncService,
    private readonly passwordService: PasswordService,
    private readonly emailService: EmailService,
    @Optional()
    private readonly adminAuditService?: AdminAuditService,
  ) {}

  private buyerName(buyer: any): string {
    return [
      resolveRequiredProfileField(buyer ?? {}, 'firstName'),
      resolveRequiredProfileField(buyer ?? {}, 'lastName'),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  async findAll(brandId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [total, payouts] = await Promise.all([
      this.prisma.payout.count({ where: { brandId } }),
      this.prisma.payout.findMany({
        where: { brandId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      items: payouts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Step one of two: validate the payout, then email a code to authorise it.
   *
   * A session on its own must not be able to move money off the platform. The
   * threat is not an attacker guessing a payout — it is a session that is
   * already authenticated: a device left open, a stolen token, a staff account
   * that should no longer have reach. Every one of those can press "Request
   * payout", and nothing downstream asks a second question, so control of the
   * account's inbox is now the second question.
   *
   * Everything that could reject the payout runs BEFORE a code is sent. A code
   * that arrives and then cannot be used is worse than no code: it trains the
   * person to ignore the email, which is the one place an unauthorised payout
   * is visible to them.
   *
   * No payout row is created here. Nothing is reserved, nothing is held; a
   * challenge that is never confirmed simply expires.
   */
  async requestPayout(
    brandId: string,
    amount: number,
    actorUserId?: string | null,
  ): Promise<PayoutChallengeResult> {
    const userId = String(actorUserId ?? '').trim();
    if (!userId) {
      // Previously optional, and only used for the audit trail. A payout that
      // nobody is on the hook for cannot be authorised by anybody either.
      throw new BadRequestException(
        'Sign in again before requesting a payout.',
      );
    }

    if (amount < 5000) {
      throw new BadRequestException('Minimum payout amount is 5000');
    }

    await this.assertBrandExists(brandId);
    await this.assertPayoutAccountReadyForRequest(brandId);
    await this.syncFinanceSources(brandId);
    const balance = await this.calculateAvailableBalance(brandId);

    if (amount > balance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${balance}`,
      );
    }

    return this.issuePayoutChallenge(brandId, amount, userId);
  }

  /**
   * Step two: spend the code and create the payout.
   *
   * The amount is taken from the CODE, not from the request. A client that
   * could name its own amount here would have turned the challenge into a
   * formality — confirm a ₦5,000 payout, submit ₦500,000. `pendingValue` binds
   * the code to the brand and the amount it was issued for, and a mismatch is
   * treated as a bad code rather than explained, because the only way to
   * produce one is to be tampering.
   */
  async confirmPayoutRequest(
    brandId: string,
    submittedCode: string,
    actorUserId?: string | null,
  ) {
    const userId = String(actorUserId ?? '').trim();
    if (!userId) {
      throw new BadRequestException('Sign in again before requesting a payout.');
    }

    const now = new Date();
    const activeCode = await this.prisma.emailLoginCode.findFirst({
      where: {
        userId,
        purpose: LoginCodePurpose.PAYOUT_REQUEST,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (
      !activeCode ||
      !activeCode.pendingValue ||
      activeCode.attempts >= PAYOUT_CODE_MAX_ATTEMPTS
    ) {
      throw new BadRequestException(PAYOUT_CODE_REJECTED_MESSAGE);
    }

    const valid = await this.passwordService
      .verifyPassword(activeCode.codeHash, String(submittedCode ?? '').trim())
      .catch(() => false);

    if (!valid) {
      const spent = activeCode.attempts + 1 >= PAYOUT_CODE_MAX_ATTEMPTS;
      await this.prisma.emailLoginCode.update({
        where: { id: activeCode.id },
        data: {
          attempts: { increment: 1 },
          // Burn the code once the budget is spent, so a wrong guess cannot be
          // retried indefinitely against a live code.
          ...(spent ? { usedAt: now } : {}),
        },
      });
      throw new BadRequestException(
        spent
          ? 'Too many incorrect codes. Request a new payout code to try again.'
          : PAYOUT_CODE_REJECTED_MESSAGE,
      );
    }

    const authorised = this.parsePayoutChallengeValue(activeCode.pendingValue);
    if (!authorised || authorised.brandId !== brandId) {
      throw new BadRequestException(PAYOUT_CODE_REJECTED_MESSAGE);
    }

    const amount = authorised.amount;

    /*
      Re-validated at confirmation, not trusted from the request. Ten minutes
      is long enough for the balance to move, for the payout account to be
      changed, or for another payout to be confirmed from a second tab.
    */
    await this.assertPayoutAccountReadyForRequest(brandId);
    await this.syncFinanceSources(brandId);
    const balance = await this.calculateAvailableBalance(brandId);
    if (amount > balance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${balance}`,
      );
    }

    return this.createPayoutRecord(brandId, amount, userId, activeCode.id);
  }

  private async createPayoutRecord(
    brandId: string,
    amount: number,
    actorUserId: string,
    challengeCodeId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      /*
        Claim the code inside the same transaction that creates the payout, with
        the same predicate it was found by. `updateMany` reporting one row is
        what makes a double confirmation — two tabs, an impatient double press,
        a retried request — produce one payout instead of two.
      */
      const claimed = await tx.emailLoginCode.updateMany({
        where: {
          id: challengeCodeId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(PAYOUT_CODE_REJECTED_MESSAGE);
      }

      return this.writePayoutRow(tx, brandId, amount, actorUserId);
    });
  }

  private async writePayoutRow(
    tx: Prisma.TransactionClient,
    brandId: string,
    amount: number,
    actorUserId?: string | null,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "Brand" WHERE "id" = ${brandId}::uuid FOR UPDATE`;
    const refreshedBalance = await this.calculateAvailableBalance(brandId);
    if (amount > refreshedBalance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${refreshedBalance}`,
      );
    }

    const payoutId = uuidv4();
    const payout = await tx.payout.create({
      data: {
        id: payoutId,
        brandId,
        amount,
        currency: 'NGN',
        status: PayoutStatus.PENDING_APPROVAL,
      },
    });

    await this.reserveLedgerSources(
      tx,
      brandId,
      payoutId,
      amount,
      payout.currency,
    );
    if (actorUserId) {
      await this.adminAuditService?.safeLogInTransaction(tx, {
        actorUserId,
        action: 'BRAND_PAYOUT_REQUEST' as AdminAuditAction,
        targetType: 'Payout',
        targetId: payout.id,
        metadata: {
          brandId,
          currency: payout.currency,
          status: payout.status,
          // The payout was authorised by a code, not by the session alone.
          authorisedBy: 'EMAIL_OTP',
        },
        newState: {
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
        },
      });
    }
    return payout;
  }

  /**
   * Mint a payout code, supersede any earlier one, and email it.
   *
   * The code goes to the account's own email and only when that email is
   * VERIFIED. An unverified address is one nobody has proven control of, so
   * sending a payout authorisation there would hand the second factor to
   * whoever typed it — which is the first factor's problem all over again.
   */
  private async issuePayoutChallenge(
    brandId: string,
    amount: number,
    userId: string,
  ): Promise<PayoutChallengeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isEmailVerified: true },
    });

    if (!user?.email) {
      throw new BadRequestException('Sign in again before requesting a payout.');
    }

    if (!user.isEmailVerified) {
      throw new BadRequestException({
        code: 'PAYOUT_EMAIL_NOT_VERIFIED',
        message:
          'Verify your email address before requesting a payout. WIEZ sends the payout confirmation code there.',
      });
    }

    const now = new Date();

    /*
      A cooldown, not a rate limiter. Pressing the button again is the obvious
      thing to do when an email is slow, and every press invalidates the code
      already in the person's inbox — so without this, an impatient brand can
      lock themselves into a loop where the code they are reading is never the
      live one.
    */
    const recent = await this.prisma.emailLoginCode.findFirst({
      where: {
        userId,
        purpose: LoginCodePurpose.PAYOUT_REQUEST,
        usedAt: null,
        expiresAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - PAYOUT_CODE_RESEND_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (recent) {
      const waitSeconds = Math.max(
        1,
        Math.ceil(
          (recent.createdAt.getTime() + PAYOUT_CODE_RESEND_COOLDOWN_MS - now.getTime()) / 1000,
        ),
      );
      throw new BadRequestException({
        code: 'PAYOUT_CODE_COOLDOWN',
        message: `A payout code was just sent to your email. Ask for another in ${waitSeconds}s.`,
      });
    }

    const code = this.generatePayoutCode();
    const codeHash = await this.passwordService.hashPassword(code);
    const expiresAt = new Date(now.getTime() + PAYOUT_CODE_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // Requesting again supersedes anything still in flight, so a brand who
      // changed the amount cannot confirm the previous one by accident.
      await tx.emailLoginCode.updateMany({
        where: {
          userId,
          purpose: LoginCodePurpose.PAYOUT_REQUEST,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      await tx.emailLoginCode.create({
        data: {
          id: uuidv4(),
          userId,
          purpose: LoginCodePurpose.PAYOUT_REQUEST,
          codeHash,
          pendingValue: this.buildPayoutChallengeValue(brandId, amount),
          expiresAt,
        },
      });
    });

    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { name: true },
    });

    const emailContent = emailTemplates.payoutRequestCodeEmail(
      code,
      this.formatPayoutAmount(amount),
      brand?.name || 'your brand',
      this.emailService.getAppName(),
    );

    /*
      Sent directly rather than through the scenario gate. This is not a
      notification the brand can have opted out of — they pressed a button one
      second ago and are waiting for it, and a preference silently swallowing it
      would present as "payouts are broken".
    */
    await this.emailService.send(
      user.email,
      emailContent.subject,
      emailContent.html,
      emailContent.text,
      {
        recipientUserId: user.id,
        priority: EmailPriority.P0_SECURITY,
        dispatchImmediately: true,
      },
    );

    return {
      challengeRequired: true,
      amount,
      expiresInSeconds: Math.floor(PAYOUT_CODE_TTL_MS / 1000),
      maxAttempts: PAYOUT_CODE_MAX_ATTEMPTS,
      resendAfterSeconds: Math.floor(PAYOUT_CODE_RESEND_COOLDOWN_MS / 1000),
      emailHint: this.maskEmailForHint(user.email),
      message: 'Enter the 6-digit code we emailed you to release this payout.',
    };
  }

  /** Six digits, from a CSPRNG. `Math.random` is not a source for this. */
  private generatePayoutCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /**
   * What the code authorises, canonically. Amount is fixed to 2dp so the value
   * written at issue and the value compared at confirmation cannot differ by
   * float formatting.
   */
  private buildPayoutChallengeValue(brandId: string, amount: number): string {
    return `${brandId}|${amount.toFixed(2)}`;
  }

  private parsePayoutChallengeValue(
    value: string,
  ): { brandId: string; amount: number } | null {
    const [brandId, rawAmount] = String(value ?? '').split('|');
    const amount = Number(rawAmount);
    if (!brandId || !Number.isFinite(amount) || amount <= 0) return null;
    return { brandId, amount };
  }

  private formatPayoutAmount(amount: number): string {
    return `₦${amount.toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  /** Enough to recognise the inbox, not enough to learn the address. */
  private maskEmailForHint(email: string): string {
    const [local, domain] = String(email).split('@');
    if (!domain) return '';
    const head = local.slice(0, local.length <= 2 ? 1 : 2);
    return `${head}${'*'.repeat(3)}@${domain}`;
  }

  async getOverview(brandId: string) {
    await this.assertBrandExists(brandId);
    await this.syncFinanceSources(brandId);
    const {
      availableBalance,
      releasedBalance,
      reservedPayoutBalance,
      paidOutBalance,
    } = await this.calculateBalanceSnapshot(brandId);

    const [
      orderStats,
      customOrderStats,
      activeEscrowHolds,
      queuedCustomAllocations,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: { brandId, paymentStatus: 'PAID' },
        _count: { id: true },
      }),
      (this.prisma as any).customOrder.aggregate({
        where: { brandId, paymentStatus: 'PAID' },
        _count: { id: true },
      }),
      this.prisma.escrowHold.count({
        where: {
          brandId,
          status: { in: ['HELD', 'PARTIALLY_RELEASED', 'FROZEN'] as any },
        },
      }),
      this.prisma.customOrderLedgerAllocation.count({
        where: {
          customOrder: { brandId },
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
          payoutId: null,
        },
      }),
    ]);

    return {
      currency: 'NGN',
      availableBalance,
      releasedBalance,
      reservedPayoutBalance,
      paidOutBalance,
      incomingCredits: releasedBalance,
      totalOrders:
        (orderStats._count?.id ?? 0) + (customOrderStats._count?.id ?? 0),
      activeEscrowHolds,
      queuedCustomAllocations,
      negativeBalance: availableBalance < 0,
    };
  }

  async listIncomingTransactions(brandId: string, page = 1, limit = 20) {
    await this.assertBrandExists(brandId);
    await this.syncFinanceSources(brandId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;
    // Over-fetch slightly so merge with bounded fallbacks stays correct without loading all history.
    const ledgerFetchLimit = Math.min(100, skip + safeLimit);

    const [entries, entryTotal, legacyOrders, fallbackCustomAllocations] =
      await Promise.all([
        (this.prisma as any).ledgerEntry.findMany({
          where: {
            account: {
              entityType: 'BRAND',
              entityId: brandId,
              subType: 'BRAND_AVAILABLE',
            },
            direction: 'CREDIT',
          },
          orderBy: { createdAt: 'desc' },
          take: ledgerFetchLimit,
          include: {
            account: {
              select: {
                code: true,
                name: true,
              },
            },
            transaction: {
              select: {
                id: true,
                type: true,
                description: true,
                referenceType: true,
                referenceId: true,
                totalAmount: true,
                currency: true,
                createdAt: true,
                metadata: true,
                entries: {
                  select: {
                    direction: true,
                    amount: true,
                    account: {
                      select: {
                        subType: true,
                        entityId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        (this.prisma as any).ledgerEntry.count({
          where: {
            account: {
              entityType: 'BRAND',
              entityId: brandId,
              subType: 'BRAND_AVAILABLE',
            },
            direction: 'CREDIT',
          },
        }),
        this.prisma.order.findMany({
          where: {
            brandId,
            paymentStatus: 'PAID' as any,
            escrowHold: { is: null },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            totalAmount: true,
            currency: true,
            customerName: true,
            createdAt: true,
            status: true,
          },
        }),
        this.prisma.customOrderLedgerAllocation.findMany({
          where: {
            customOrder: { brandId },
            status: {
              in: [
                CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                CustomOrderLedgerAllocationStatus.PAID_OUT,
              ],
            },
          },
          orderBy: [{ eligibleAt: 'desc' }, { createdAt: 'desc' }],
          take: 40,
          select: {
            id: true,
            allocationType: true,
            amount: true,
            commissionAmount: true,
            netBrandAmount: true,
            currency: true,
            eligibleAt: true,
            paidOutAt: true,
            createdAt: true,
            customOrderId: true,
            customOrder: {
              select: {
                id: true,
                sourceTitleSnapshot: true,
                buyer: {
                  select: {
                    userProfile: { select: canonicalUserProfileSelect },
                    username: true,
                  },
                },
              },
            },
          },
        }),
      ]);

    const orderIds: string[] = [
      ...new Set<string>(
        entries
          .filter(
            (entry: any) =>
              entry.transaction?.referenceType === 'Order' &&
              entry.transaction?.referenceId,
          )
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    ];
    const customOrderIds: string[] = [
      ...new Set<string>(
        entries
          .filter(
            (entry: any) =>
              entry.transaction?.referenceType === 'CustomOrder' &&
              entry.transaction?.referenceId,
          )
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    ];

    const [orders, customOrders] = await Promise.all([
      orderIds.length > 0
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: {
              id: true,
              customerName: true,
              orderItems: {
                take: 1,
                select: {
                  nameAtPurchase: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      customOrderIds.length > 0
        ? this.prisma.customOrder.findMany({
            where: { id: { in: customOrderIds } },
            select: {
              id: true,
              sourceTitleSnapshot: true,
              buyer: {
                select: {
                  userProfile: { select: canonicalUserProfileSelect },
                  username: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const orderById = new Map<
      string,
      { title: string; counterparty: string | null }
    >(
      orders.map((order) => {
        const firstItem = order.orderItems[0];
        return [
          order.id,
          {
            title:
              (typeof firstItem?.nameAtPurchase === 'string' &&
                firstItem.nameAtPurchase.trim()) ||
              `Order #${order.id.slice(0, 8).toUpperCase()}`,
            counterparty: order.customerName,
          },
        ] as const;
      }),
    );

    const customOrderById = new Map<
      string,
      { title: string; counterparty: string | null }
    >(
      customOrders.map((order: any) => {
        const buyerName = this.buyerName(order?.buyer);

        return [
          String(order.id),
          {
            title:
              (typeof order?.sourceTitleSnapshot === 'string' &&
                order.sourceTitleSnapshot.trim()) ||
              `Custom Order #${String(order.id).slice(0, 8).toUpperCase()}`,
            counterparty:
              buyerName || String(order?.buyer?.username || 'Buyer'),
          },
        ] as const;
      }),
    );

    const ledgerCustomReleaseKeys = new Set<string>();
    for (const entry of entries) {
      const transaction = entry.transaction;
      if (
        String(transaction?.referenceType || '') !== 'CustomOrder' ||
        !transaction?.referenceId
      ) {
        continue;
      }

      const stage = this.resolveReleaseStage(transaction?.description);
      ledgerCustomReleaseKeys.add(
        `${String(transaction.referenceId)}:${stage}`,
      );
    }

    const ledgerItems = entries.map((entry: any) => {
      const transaction = entry.transaction;
      const referenceType = String(transaction?.referenceType || '');
      const referenceId = String(transaction?.referenceId || '');
      const orderMeta =
        referenceType === 'Order'
          ? orderById.get(referenceId)
          : referenceType === 'CustomOrder'
            ? customOrderById.get(referenceId)
            : null;

      return {
        id: entry.id,
        amount: Number(entry.amount ?? 0),
        grossAmount: this.roundMoney(
          Number(transaction?.totalAmount ?? entry.amount ?? 0),
        ),
        commissionAmount: this.roundMoney(
          Array.isArray(transaction?.entries)
            ? transaction.entries
                .filter(
                  (line: any) =>
                    line.direction === 'CREDIT' &&
                    line.account?.subType === 'PLATFORM_COMMISSION',
                )
                .reduce(
                  (sum: number, line: any) => sum + Number(line.amount ?? 0),
                  0,
                )
            : 0,
        ),
        netAmount: this.roundMoney(Number(entry.amount ?? 0)),
        balanceAfter: Number(entry.balanceAfter ?? 0),
        currency: transaction?.currency ?? 'NGN',
        createdAt: entry.createdAt,
        transactionId: transaction?.id ?? null,
        transactionType: transaction?.type ?? null,
        description: transaction?.description ?? null,
        referenceType: transaction?.referenceType ?? null,
        referenceId: transaction?.referenceId ?? null,
        title:
          orderMeta?.title ??
          transaction?.description ??
          'Incoming transaction',
        counterparty: orderMeta?.counterparty ?? null,
        stage:
          String(transaction?.type || '').toUpperCase() === 'ESCROW_RELEASE'
            ? this.resolveReleaseStage(transaction?.description)
            : 'PAYMENT',
        metadata: transaction?.metadata ?? Prisma.JsonNull,
      };
    });

    const legacyItems = await this.buildLegacyStandardIncomeItems(
      brandId,
      legacyOrders,
    );
    const customFallbackItems = fallbackCustomAllocations
      .filter((allocation) => {
        const stage = this.mapCustomAllocationStage(allocation.allocationType);
        return !ledgerCustomReleaseKeys.has(
          `${allocation.customOrderId}:${stage}`,
        );
      })
      .map((allocation) => {
        const buyerName = [
          resolveRequiredProfileField(
            allocation.customOrder?.buyer ?? {},
            'firstName',
          ),
          resolveRequiredProfileField(
            allocation.customOrder?.buyer ?? {},
            'lastName',
          ),
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' ');

        const stage = this.mapCustomAllocationStage(allocation.allocationType);
        return {
          id: allocation.id,
          amount: this.roundMoney(Number(allocation.netBrandAmount ?? 0)),
          grossAmount: this.roundMoney(Number(allocation.amount ?? 0)),
          commissionAmount: this.roundMoney(
            Number(allocation.commissionAmount ?? 0),
          ),
          netAmount: this.roundMoney(Number(allocation.netBrandAmount ?? 0)),
          balanceAfter: 0,
          currency: allocation.currency || 'NGN',
          createdAt:
            allocation.eligibleAt ??
            allocation.paidOutAt ??
            allocation.createdAt,
          transactionId: null,
          transactionType: 'ESCROW_RELEASE',
          description:
            stage === 'ACCEPTED_RELEASE'
              ? `Immediate custom-order release for ${allocation.customOrderId.slice(0, 8).toUpperCase()}`
              : `Final custom-order release for ${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          referenceType: 'CustomOrder',
          referenceId: allocation.customOrderId,
          title:
            allocation.customOrder?.sourceTitleSnapshot ||
            `Custom Order #${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          counterparty:
            buyerName ||
            String(allocation.customOrder?.buyer?.username || 'Buyer'),
          stage,
          metadata: null,
        };
      });

    const allItems = [
      ...ledgerItems,
      ...legacyItems,
      ...customFallbackItems,
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // total ≈ ledger count + fallback rows not already represented in ledger
    const total = Math.max(
      Number(entryTotal || 0) + legacyItems.length + customFallbackItems.length,
      allItems.length,
    );

    return {
      items: allItems.slice(skip, skip + safeLimit),
      total,
      page: safePage,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  async listHeldFunds(brandId: string, page = 1, limit = 20) {
    await this.assertBrandExists(brandId);
    await this.syncFinanceSources(brandId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [standardHolds, customHeldAllocations, customAcceptanceAllocations] =
      await Promise.all([
        this.prisma.escrowHold.findMany({
          where: {
            brandId,
            status: { in: ['HELD', 'PARTIALLY_RELEASED', 'FROZEN'] as any },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            orderId: true,
            totalAmount: true,
            commissionAmount: true,
            netBrandAmount: true,
            currency: true,
            status: true,
            firstReleaseAmount: true,
            firstReleaseNetAmount: true,
            secondReleaseAmount: true,
            secondReleaseNetAmount: true,
            firstReleasedAt: true,
            secondReleaseEligibleAt: true,
            secondReleaseCondition: true,
            frozenReason: true,
            createdAt: true,
            order: {
              select: {
                id: true,
                customerName: true,
              },
            },
          },
        }),
        this.prisma.customOrderLedgerAllocation.findMany({
          where: {
            customOrder: { brandId },
            allocationType:
              CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
            status: CustomOrderLedgerAllocationStatus.HELD,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            customOrderId: true,
            amount: true,
            commissionAmount: true,
            netBrandAmount: true,
            currency: true,
            createdAt: true,
            customOrder: {
              select: {
                sourceTitleSnapshot: true,
                buyer: {
                  select: {
                    userProfile: { select: canonicalUserProfileSelect },
                    username: true,
                  },
                },
              },
            },
          },
        }),
        this.prisma.customOrderLedgerAllocation.findMany({
          where: {
            customOrder: { brandId },
            allocationType:
              CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
            status: {
              in: [
                CustomOrderLedgerAllocationStatus.HELD,
                CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
                CustomOrderLedgerAllocationStatus.PAID_OUT,
              ],
            },
          },
          orderBy: [{ customOrderId: 'asc' }, { createdAt: 'asc' }],
          select: {
            customOrderId: true,
            amount: true,
            commissionAmount: true,
            netBrandAmount: true,
            status: true,
          },
        }),
      ]);

    const acceptanceAllocationByCustomOrderId = new Map<
      string,
      (typeof customAcceptanceAllocations)[number]
    >();
    for (const allocation of customAcceptanceAllocations) {
      if (!acceptanceAllocationByCustomOrderId.has(allocation.customOrderId)) {
        acceptanceAllocationByCustomOrderId.set(
          allocation.customOrderId,
          allocation,
        );
      }
    }

    const items = [
      ...standardHolds.map((hold) => ({
        id: hold.id,
        holdType: 'STANDARD_ORDER',
        referenceId: hold.orderId,
        title: hold.order?.id
          ? `Order #${hold.order.id.slice(0, 8).toUpperCase()}`
          : 'Standard order hold',
        counterparty: hold.order?.customerName ?? 'Buyer',
        currency: hold.currency,
        grossAmount: this.roundMoney(Number(hold.totalAmount ?? 0)),
        commissionAmount: this.roundMoney(Number(hold.commissionAmount ?? 0)),
        netBrandAmount: this.roundMoney(Number(hold.netBrandAmount ?? 0)),
        releasedGrossAmount: this.roundMoney(
          hold.firstReleasedAt ? Number(hold.firstReleaseAmount ?? 0) : 0,
        ),
        releasedNetAmount: this.roundMoney(
          hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount ?? 0) : 0,
        ),
        heldGrossAmount: this.roundMoney(Number(hold.secondReleaseAmount ?? 0)),
        heldNetAmount: this.roundMoney(
          Number(hold.secondReleaseNetAmount ?? 0),
        ),
        status: hold.status,
        nextReleaseAt: hold.secondReleaseEligibleAt,
        releaseCondition: hold.secondReleaseCondition,
        frozenReason: hold.frozenReason ?? null,
        canRequestManualRelease:
          hold.status !== 'FROZEN' &&
          hold.status !== 'RELEASED' &&
          Boolean(hold.orderId),
        createdAt: hold.createdAt,
      })),
      ...customHeldAllocations.map((allocation) => {
        const buyerName = [
          resolveRequiredProfileField(
            allocation.customOrder?.buyer ?? {},
            'firstName',
          ),
          resolveRequiredProfileField(
            allocation.customOrder?.buyer ?? {},
            'lastName',
          ),
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' ');

        const acceptanceAllocation =
          acceptanceAllocationByCustomOrderId.get(allocation.customOrderId) ??
          null;
        const acceptanceStatus = acceptanceAllocation?.status ?? null;
        const acceptanceGrossAmount = Number(acceptanceAllocation?.amount ?? 0);
        const acceptanceCommissionAmount = Number(
          acceptanceAllocation?.commissionAmount ?? 0,
        );
        const acceptanceNetAmount = Number(
          acceptanceAllocation?.netBrandAmount ?? 0,
        );
        const acceptanceIsReleased =
          acceptanceStatus ===
            CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
          acceptanceStatus === CustomOrderLedgerAllocationStatus.PAID_OUT;
        const acceptanceIsHeld =
          acceptanceStatus === CustomOrderLedgerAllocationStatus.HELD;
        const finalGrossAmount = Number(allocation.amount ?? 0);
        const finalCommissionAmount = Number(allocation.commissionAmount ?? 0);
        const finalNetAmount = Number(allocation.netBrandAmount ?? 0);

        const releasedGrossAmount = acceptanceIsReleased
          ? acceptanceGrossAmount
          : 0;
        const releasedNetAmount = acceptanceIsReleased
          ? acceptanceNetAmount
          : 0;
        const heldGrossAmount =
          finalGrossAmount + (acceptanceIsHeld ? acceptanceGrossAmount : 0);
        const heldNetAmount =
          finalNetAmount + (acceptanceIsHeld ? acceptanceNetAmount : 0);
        const grossAmount = acceptanceGrossAmount + finalGrossAmount;
        const commissionAmount =
          acceptanceCommissionAmount + finalCommissionAmount;
        const netBrandAmount = this.roundMoney(
          releasedNetAmount + heldNetAmount,
        );

        return {
          id: allocation.id,
          holdType: 'CUSTOM_ORDER',
          referenceId: allocation.customOrderId,
          title:
            allocation.customOrder?.sourceTitleSnapshot ||
            `Custom Order #${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          counterparty:
            buyerName ||
            String(allocation.customOrder?.buyer?.username || 'Buyer'),
          currency: allocation.currency || 'NGN',
          grossAmount: this.roundMoney(grossAmount),
          commissionAmount: this.roundMoney(commissionAmount),
          netBrandAmount,
          releasedGrossAmount: this.roundMoney(releasedGrossAmount),
          releasedNetAmount: this.roundMoney(releasedNetAmount),
          heldGrossAmount: this.roundMoney(heldGrossAmount),
          heldNetAmount: this.roundMoney(heldNetAmount),
          status: 'HELD',
          nextReleaseAt: null,
          releaseCondition: 'BUYER_DELIVERY_CONFIRMED',
          frozenReason: null,
          canRequestManualRelease: false,
          createdAt: allocation.createdAt,
        };
      }),
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      items: items.slice(skip, skip + safeLimit),
      total: items.length,
      page: safePage,
      totalPages: Math.ceil(items.length / safeLimit),
    };
  }

  private async calculateAvailableBalance(brandId: string): Promise<number> {
    const snapshot = await this.calculateBalanceSnapshot(brandId);
    return snapshot.availableBalance;
  }

  private async calculateBalanceSnapshot(brandId: string) {
    const [
      standardReleasedBalance,
      customReleasedBalance,
      legacyFallbackBalance,
      payoutTotals,
    ] = await Promise.all([
      this.standardOrderEscrowService.getReleasedBalance(brandId),
      this.getCustomOrderReleasedBalance(brandId),
      this.getLegacyFallbackBalance(brandId),
      this.prisma.payout.groupBy({
        by: ['status'],
        where: { brandId },
        _sum: { amount: true },
      }),
    ]);

    const reservedStatuses = this.getReservedPayoutStatuses();

    const reservedPayoutBalance = payoutTotals.reduce((sum, row) => {
      if (!reservedStatuses.has(row.status)) {
        return sum;
      }
      return sum + Number(row._sum.amount ?? 0);
    }, 0);

    const paidOutBalance = payoutTotals.reduce((sum, row) => {
      if (row.status !== PayoutStatus.PAID) {
        return sum;
      }
      return sum + Number(row._sum.amount ?? 0);
    }, 0);

    const releasedBalance = this.roundMoney(
      standardReleasedBalance + customReleasedBalance + legacyFallbackBalance,
    );
    const availableBalance = this.roundMoney(
      releasedBalance - reservedPayoutBalance - paidOutBalance,
    );

    return {
      availableBalance,
      releasedBalance,
      reservedPayoutBalance: this.roundMoney(reservedPayoutBalance),
      paidOutBalance: this.roundMoney(paidOutBalance),
    };
  }

  private async getCustomOrderReleasedBalance(
    brandId: string,
  ): Promise<number> {
    const released = await this.prisma.customOrderLedgerAllocation.aggregate({
      where: {
        customOrder: { brandId },
        status: {
          in: [
            CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            CustomOrderLedgerAllocationStatus.PAID_OUT,
          ],
        },
      },
      _sum: {
        netBrandAmount: true,
      },
    });

    return this.roundMoney(Number(released._sum.netBrandAmount ?? 0));
  }

  private async getLegacyFallbackBalance(brandId: string): Promise<number> {
    const paidOrders = await this.prisma.order.findMany({
      where: {
        brandId,
        paymentStatus: 'PAID',
        escrowHold: { is: null },
      },
      select: {
        totalAmount: true,
        currency: true,
      },
    });

    if (paidOrders.length === 0) {
      return 0;
    }

    const rateMap = await this.getCommissionRateMap(
      brandId,
      paidOrders.map((order) => String(order.currency || 'NGN')),
    );

    return this.roundMoney(
      paidOrders.reduce((sum, order) => {
        const grossAmount = Number(order.totalAmount ?? 0);
        const commissionRate =
          rateMap.get(String(order.currency || 'NGN').toUpperCase()) ?? 0;
        const commissionAmount = this.roundMoney(
          (grossAmount * commissionRate) / 100,
        );
        return sum + this.roundMoney(grossAmount - commissionAmount);
      }, 0),
    );
  }

  private async buildLegacyStandardIncomeItems(
    brandId: string,
    orders: Array<{
      id: string;
      totalAmount: Prisma.Decimal;
      currency: string;
      customerName: string;
      createdAt: Date;
      status: string;
    }>,
  ) {
    if (orders.length === 0) {
      return [];
    }

    const rateMap = await this.getCommissionRateMap(
      brandId,
      orders.map((order) => String(order.currency || 'NGN')),
    );

    return orders.map((order) => {
      const grossAmount = Number(order.totalAmount ?? 0);
      const commissionRate =
        rateMap.get(String(order.currency || 'NGN').toUpperCase()) ?? 0;
      const commissionAmount = this.roundMoney(
        (grossAmount * commissionRate) / 100,
      );
      const netAmount = this.roundMoney(grossAmount - commissionAmount);

      return {
        id: order.id,
        amount: netAmount,
        grossAmount: this.roundMoney(grossAmount),
        commissionAmount,
        netAmount,
        balanceAfter: 0,
        currency: order.currency || 'NGN',
        createdAt: order.createdAt,
        transactionId: null,
        transactionType: 'PAYMENT_RECEIVED',
        description: `Payment for order #${order.id.slice(0, 8).toUpperCase()}`,
        referenceType: 'Order',
        referenceId: order.id,
        title: `Order #${order.id.slice(0, 8).toUpperCase()}`,
        counterparty: order.customerName,
        stage:
          String(order.status) === 'DELIVERED'
            ? 'DELIVERED_RELEASE'
            : String(order.status) === 'SHIPPED'
              ? 'SHIPPED_RELEASE'
              : 'PAYMENT',
        metadata: null,
      };
    });
  }

  private async getCommissionRateMap(brandId: string, currencies: string[]) {
    const uniqueCurrencies = Array.from(
      new Set(
        currencies
          .map((currency) =>
            String(currency || 'NGN')
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      ),
    );

    const resolvedRules = await Promise.all(
      uniqueCurrencies.map(async (currency) => {
        const resolved = await this.commissionService.resolveRule({
          brandId,
          currency,
        });
        return [currency, resolved.ratePercent] as const;
      }),
    );

    return new Map<string, number>(resolvedRules);
  }

  private async syncFinanceSources(brandId: string) {
    await Promise.all([
      this.syncLegacyStandardOrderSources(brandId),
      this.customOrderFinanceSyncService.ensureSettlementsForBrand(brandId, 25),
    ]);
  }

  private async syncLegacyStandardOrderSources(brandId: string) {
    const legacyOrderIds = await this.prisma.order.findMany({
      where: {
        brandId,
        paymentStatus: 'PAID',
        paymentReference: { not: null },
        escrowHold: { is: null },
      },
      select: { id: true },
      take: 50,
    });

    if (legacyOrderIds.length === 0) {
      return;
    }

    await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds(
      legacyOrderIds.map((order) => order.id),
    );
  }

  private async reserveLedgerSources(
    tx: Prisma.TransactionClient,
    brandId: string,
    payoutId: string,
    requestedAmount: number,
    currency: string,
  ) {
    const reservedStatuses = [
      ...this.getReservedPayoutStatuses(),
      PayoutStatus.PAID,
    ];
    const creditEntries = await (tx as any).ledgerEntry.findMany({
      where: {
        direction: 'CREDIT',
        account: {
          entityType: 'BRAND',
          entityId: brandId,
          subType: 'BRAND_AVAILABLE',
        },
        transaction: {
          currency,
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        amount: true,
        createdAt: true,
        transaction: {
          select: {
            id: true,
            type: true,
            referenceType: true,
            referenceId: true,
            description: true,
          },
        },
        payoutSourceAllocations: {
          where: {
            payout: {
              status: { in: reservedStatuses },
            },
          },
          select: {
            amount: true,
          },
        },
      },
    });

    let remaining = this.roundMoney(requestedAmount);
    const rows: Array<{
      payoutId: string;
      ledgerEntryId: string;
      amount: Prisma.Decimal;
      currency: string;
      escrowHoldId?: string | null;
      releaseStage?: 'SHIPMENT_PORTION' | 'FINAL_PORTION';
    }> = [];

    for (const entry of creditEntries) {
      const alreadyReserved = this.roundMoney(
        (entry.payoutSourceAllocations ?? []).reduce(
          (sum: number, allocation: { amount: Prisma.Decimal }) =>
            sum + Number(allocation.amount ?? 0),
          0,
        ),
      );
      const available = this.roundMoney(
        Number(entry.amount ?? 0) - alreadyReserved,
      );
      if (available <= 0) {
        continue;
      }

      const toReserve = this.roundMoney(Math.min(available, remaining));
      if (toReserve <= 0) {
        continue;
      }

      const metadata = await this.resolveEscrowSourceForLedgerEntry(tx, {
        referenceType: entry.transaction?.referenceType,
        referenceId: entry.transaction?.referenceId,
        description: entry.transaction?.description,
      });
      rows.push({
        payoutId,
        ledgerEntryId: entry.id,
        amount: new Prisma.Decimal(toReserve.toFixed(2)),
        currency,
        escrowHoldId: metadata.escrowHoldId,
        releaseStage: metadata.releaseStage,
      });

      remaining = this.roundMoney(remaining - toReserve);
      if (remaining <= 0) {
        break;
      }
    }

    if (remaining > 0) {
      throw new BadRequestException(
        `Exact payout source reservation failed. Reservable balance is ${this.roundMoney(
          requestedAmount - remaining,
        )}.`,
      );
    }

    if (rows.length === 0) {
      throw new BadRequestException(
        'No payout source allocations were available to reserve',
      );
    }

    await (tx as any).payoutLedgerSourceAllocation.createMany({
      data: rows.map((row) => ({
        payoutId: row.payoutId,
        ledgerEntryId: row.ledgerEntryId,
        amount: row.amount,
        currency: row.currency,
        escrowHoldId: row.escrowHoldId ?? null,
        releaseStage: row.releaseStage ?? null,
      })),
    });
  }

  private async resolveEscrowSourceForLedgerEntry(
    tx: Prisma.TransactionClient,
    params?: {
      referenceType?: string | null;
      referenceId?: string | null;
      description?: string | null;
    },
  ): Promise<{
    escrowHoldId: string | null;
    releaseStage: 'SHIPMENT_PORTION' | 'FINAL_PORTION' | null;
  }> {
    if (
      String(params?.referenceType ?? '')
        .trim()
        .toUpperCase() !== 'ORDER'
    ) {
      return { escrowHoldId: null, releaseStage: null };
    }

    const orderId = String(params?.referenceId ?? '').trim();
    if (!orderId) {
      return { escrowHoldId: null, releaseStage: null };
    }

    const hold = await tx.escrowHold.findUnique({
      where: { orderId },
      select: { id: true, firstReleasedAt: true, secondReleasedAt: true },
    });

    if (!hold) {
      return { escrowHoldId: null, releaseStage: null };
    }

    const description = String(params?.description ?? '').toLowerCase();
    if (description.includes('shipment')) {
      return { escrowHoldId: hold.id, releaseStage: 'SHIPMENT_PORTION' };
    }
    if (description.includes('final')) {
      return { escrowHoldId: hold.id, releaseStage: 'FINAL_PORTION' };
    }
    if (hold.firstReleasedAt) {
      return { escrowHoldId: hold.id, releaseStage: 'SHIPMENT_PORTION' };
    }

    return { escrowHoldId: hold.id, releaseStage: null };
  }

  async assertBrandOwnership(brandId: string, ownerId: string): Promise<void> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.ownerId !== ownerId) {
      throw new BadRequestException('Not authorized for this brand');
    }
  }

  private async assertBrandExists(brandId: string): Promise<void> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
  }

  private async assertPayoutAccountReadyForRequest(
    brandId: string,
  ): Promise<void> {
    const paymentAccount = await (
      this.prisma as any
    ).storePaymentAccount.findUnique({
      where: { brandId },
      select: {
        status: true,
        transferRecipientCode: true,
        transferRecipientActive: true,
      },
    });

    /*
      Each of these is something the brand can FIX, so each says what to do and
      carries a code the client can act on.

      They used to be one shape of dead end: prose aimed at an operator ("Sync
      the brand payment account"), with nothing to distinguish "you never added
      an account" from "your bank details did not verify". A brand owner read
      it, had no idea which of those applied to them or where to go, and closed
      the toast. The code is what lets the client open the right screen instead.
    */
    if (!paymentAccount) {
      throw new BadRequestException({
        code: 'PAYOUT_ACCOUNT_MISSING',
        message:
          'Add the bank account WIEZ should pay you into before requesting a payout.',
      });
    }

    if (String(paymentAccount.status || '').toUpperCase() !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'PAYOUT_ACCOUNT_INACTIVE',
        message:
          'Your payout account is not active yet. Open your payout settings and confirm your bank details.',
      });
    }

    if (
      !paymentAccount.transferRecipientCode ||
      !paymentAccount.transferRecipientActive
    ) {
      throw new BadRequestException({
        code: 'PAYOUT_RECIPIENT_INACTIVE',
        message:
          'Your bank account still needs to be verified before WIEZ can pay into it. Open your payout settings to finish.',
      });
    }
  }

  private resolveReleaseStage(description?: string | null) {
    const haystack = String(description || '').toLowerCase();
    if (haystack.includes('shipment')) return 'SHIPPED_RELEASE';
    if (haystack.includes('final')) return 'DELIVERED_RELEASE';
    if (haystack.includes('immediate')) return 'ACCEPTED_RELEASE';
    return 'RELEASE';
  }

  private mapCustomAllocationStage(type: CustomOrderLedgerAllocationType) {
    return type === CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION
      ? 'ACCEPTED_RELEASE'
      : 'DELIVERED_RELEASE';
  }

  private getReservedPayoutStatuses() {
    return new Set<PayoutStatus>([
      PayoutStatus.PENDING_APPROVAL,
      PayoutStatus.APPROVED,
      PayoutStatus.PROCESSING,
      PayoutStatus.ON_HOLD,
      PayoutStatus.RECONCILIATION_REVIEW,
      PayoutStatus.FAILED,
    ]);
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
