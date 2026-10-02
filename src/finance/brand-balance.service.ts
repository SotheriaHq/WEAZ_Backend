/**
 * What a brand owes WIEZ, and how it gets paid back.
 *
 * The platform refunds a shopper the moment a refund is due. It does not wait
 * for the brand to have the money, and it does not ask the shopper to chase
 * anyone. Where the brand had already been paid for that order, WIEZ is out of
 * pocket and the brand carries a debt.
 *
 * Before this, that shortfall was invisible: `availableBalance` is
 * `released - reserved - paidOut`, so a clawback simply made the number go
 * negative, with no record of what caused it, no history, and nothing a brand
 * could be shown or an admin could explain. A negative number is not an account.
 *
 * Recovery is automatic and oldest-first: every later release is applied to the
 * longest-standing debt before anything becomes payable. A brand carrying a debt
 * must acknowledge it in words before accepting new custom work — see
 * `assertCustomOrderAcceptanceAllowed`.
 */
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import {
  BrandBalanceAdjustmentStatus,
  BrandBalanceAdjustmentType,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';

/** Statuses that still take money out of what a brand can withdraw. */
const ACTIVE_DEBT_STATUSES: BrandBalanceAdjustmentStatus[] = [
  BrandBalanceAdjustmentStatus.OUTSTANDING,
  BrandBalanceAdjustmentStatus.PARTIALLY_RECOVERED,
];

export type BrandDebtSnapshot = {
  /** Total still owed across every live adjustment. */
  outstanding: number;
  currency: string;
  /** How many separate debts make it up. */
  count: number;
  /** The oldest unpaid one, which is what recovery hits first. */
  oldestAt: Date | null;
  inDebt: boolean;
};

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class BrandBalanceService {
  private readonly logger = new Logger(BrandBalanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so finance can be constructed in isolation (and in tests)
    // without dragging the notification stack in behind it.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  /** What this brand owes right now. Cheap enough to call on an accept screen. */
  async getDebtSnapshot(brandId: string): Promise<BrandDebtSnapshot> {
    const rows = await this.prisma.brandBalanceAdjustment.findMany({
      where: { brandId, status: { in: ACTIVE_DEBT_STATUSES } },
      select: {
        amount: true,
        recoveredAmount: true,
        currency: true,
        createdAt: true,
        type: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    let outstanding = 0;
    for (const row of rows) {
      const remaining = Number(row.amount) - Number(row.recoveredAmount);
      // A credit adjustment reduces the pile rather than adding to it.
      outstanding +=
        row.type === BrandBalanceAdjustmentType.MANUAL_CREDIT ? -remaining : remaining;
    }
    outstanding = round(Math.max(0, outstanding));

    return {
      outstanding,
      currency: rows[0]?.currency ?? 'NGN',
      count: rows.length,
      oldestAt: rows[0]?.createdAt ?? null,
      inDebt: outstanding > 0,
    };
  }

  /**
   * Record a debt. Called when the platform has refunded money the brand was
   * already paid, so the brand's own balance has to answer for it.
   *
   * Idempotent per order and type: a refund retried, or a webhook delivered
   * twice, must not bill the brand twice for the same money.
   */
  async raiseAdjustment(
    tx: Prisma.TransactionClient,
    params: {
      brandId: string;
      type: BrandBalanceAdjustmentType;
      amount: number;
      currency?: string;
      reason: string;
      customOrderId?: string | null;
      orderId?: string | null;
      createdById?: string | null;
    },
  ) {
    const amount = round(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('A balance adjustment must be a positive amount');
    }

    const duplicate = await tx.brandBalanceAdjustment.findFirst({
      where: {
        brandId: params.brandId,
        type: params.type,
        ...(params.customOrderId ? { customOrderId: params.customOrderId } : {}),
        ...(params.orderId ? { orderId: params.orderId } : {}),
      },
      select: { id: true },
    });
    if (duplicate && (params.customOrderId || params.orderId)) {
      return duplicate;
    }

    const created = await tx.brandBalanceAdjustment.create({
      data: {
        brandId: params.brandId,
        type: params.type,
        amount: new Prisma.Decimal(amount),
        currency: params.currency ?? 'NGN',
        reason: params.reason,
        customOrderId: params.customOrderId ?? null,
        orderId: params.orderId ?? null,
        createdById: params.createdById ?? null,
      },
      select: { id: true },
    });

    // Told, not discovered. Queued outside the transaction's success path on
    // purpose: a notification that fails must not roll back the debt record.
    void this.announce({
      brandId: params.brandId,
      direction: 'DEBIT',
      amount,
      currency: params.currency ?? 'NGN',
      reason: params.reason,
      customOrderId: params.customOrderId ?? null,
      orderId: params.orderId ?? null,
    });

    return created;
  }

  /**
   * Tell the brand owner that their balance moved, in either direction.
   *
   * Deliberately best-effort and fire-and-forget: the money record is the
   * source of truth, and a notification outage must not be able to undo it.
   */
  private async announce(params: {
    brandId: string;
    direction: 'DEBIT' | 'RECOVERY';
    amount: number;
    currency: string;
    reason?: string;
    customOrderId?: string | null;
    orderId?: string | null;
  }): Promise<void> {
    if (!this.notifications) return;
    try {
      const [brand, snapshot] = await Promise.all([
        this.prisma.brand.findUnique({
          where: { id: params.brandId },
          select: { ownerId: true },
        }),
        this.getDebtSnapshot(params.brandId),
      ]);
      if (!brand?.ownerId) return;

      await this.notifications.create(
        brand.ownerId,
        NotificationType.BRAND_BALANCE_ADJUSTED,
        {
          payload: {
            direction: params.direction,
            amount: params.amount,
            currency: params.currency,
            outstanding: snapshot.outstanding,
            reason: params.reason,
            customOrderId: params.customOrderId ?? undefined,
            orderId: params.orderId ?? undefined,
            targetUrl: '/studio/finance',
          },
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not announce a balance adjustment for brand ${params.brandId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Apply earnings against outstanding debt, oldest first.
   *
   * Returns what was consumed, so the caller can release only the remainder.
   * Partial payment is the normal case — a brand owing ₦40,000 who earns
   * ₦15,000 pays down ₦15,000 and keeps nothing, and the statement says exactly
   * that rather than showing a balance that silently failed to grow.
   */
  async applyEarningsToDebt(
    tx: Prisma.TransactionClient,
    params: {
      brandId: string;
      amount: number;
      customOrderId?: string | null;
      orderId?: string | null;
      note?: string;
    },
  ): Promise<{ recovered: number; remaining: number }> {
    let available = round(params.amount);
    if (!Number.isFinite(available) || available <= 0) {
      return { recovered: 0, remaining: 0 };
    }

    const debts = await tx.brandBalanceAdjustment.findMany({
      where: {
        brandId: params.brandId,
        status: { in: ACTIVE_DEBT_STATUSES },
        type: { not: BrandBalanceAdjustmentType.MANUAL_CREDIT },
      },
      orderBy: { createdAt: 'asc' },
    });

    let recovered = 0;
    for (const debt of debts) {
      if (available <= 0) break;
      const remaining = round(Number(debt.amount) - Number(debt.recoveredAmount));
      if (remaining <= 0) continue;

      const payment = round(Math.min(remaining, available));
      available = round(available - payment);
      recovered = round(recovered + payment);

      const nextRecovered = round(Number(debt.recoveredAmount) + payment);
      const settled = nextRecovered >= Number(debt.amount);

      await tx.brandBalanceAdjustment.update({
        where: { id: debt.id },
        data: {
          recoveredAmount: new Prisma.Decimal(nextRecovered),
          status: settled
            ? BrandBalanceAdjustmentStatus.RECOVERED
            : BrandBalanceAdjustmentStatus.PARTIALLY_RECOVERED,
          settledAt: settled ? new Date() : null,
        },
      });

      await tx.brandBalanceRecovery.create({
        data: {
          adjustmentId: debt.id,
          amount: new Prisma.Decimal(payment),
          currency: debt.currency,
          customOrderId: params.customOrderId ?? null,
          orderId: params.orderId ?? null,
          note: params.note ?? null,
        },
      });
    }

    if (recovered > 0) {
      void this.announce({
        brandId: params.brandId,
        direction: 'RECOVERY',
        amount: recovered,
        currency: debts[0]?.currency ?? 'NGN',
        customOrderId: params.customOrderId ?? null,
        orderId: params.orderId ?? null,
      });
    }

    return { recovered, remaining: available };
  }

  /**
   * A brand in debt may not accept custom work without saying it understands
   * what the earnings will be used for.
   *
   * Custom orders are where this bites: the shopper has already paid, the brand
   * is about to commit weeks of work, and if the money then silently disappears
   * into a debt nobody mentioned, that is a dispute of its own making. The
   * acknowledgement is per order, not per account, because the amount owed
   * changes and the brand should be agreeing to a number they were shown.
   */
  assertCustomOrderAcceptanceAllowed(params: {
    debt: BrandDebtSnapshot;
    acknowledgedAt?: Date | null;
  }): void {
    if (!params.debt.inDebt) return;
    if (params.acknowledgedAt) return;
    throw new BadRequestException('CUSTOM_ORDER_BRAND_DEBT_ACK_REQUIRED');
  }

  /**
   * The brand's statement: every debt, what has been paid off it, and by which
   * order. This is what a finance screen renders — a single negative figure is
   * not something anyone can act on or argue with.
   */
  async getStatement(brandId: string, options?: { limit?: number }) {
    const take = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const [adjustments, snapshot] = await Promise.all([
      this.prisma.brandBalanceAdjustment.findMany({
        where: { brandId },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          recoveries: {
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
        },
      }),
      this.getDebtSnapshot(brandId),
    ]);

    return {
      snapshot,
      adjustments: adjustments.map((adjustment) => ({
        id: adjustment.id,
        type: adjustment.type,
        status: adjustment.status,
        amount: Number(adjustment.amount),
        recoveredAmount: Number(adjustment.recoveredAmount),
        outstanding: round(
          Number(adjustment.amount) - Number(adjustment.recoveredAmount),
        ),
        currency: adjustment.currency,
        reason: adjustment.reason,
        customOrderId: adjustment.customOrderId,
        orderId: adjustment.orderId,
        settledAt: adjustment.settledAt,
        createdAt: adjustment.createdAt,
        recoveries: adjustment.recoveries.map((recovery) => ({
          id: recovery.id,
          amount: Number(recovery.amount),
          currency: recovery.currency,
          customOrderId: recovery.customOrderId,
          orderId: recovery.orderId,
          note: recovery.note,
          createdAt: recovery.createdAt,
        })),
      })),
    };
  }
}
