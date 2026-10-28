/**
 * What a brand owes WIEZ, and how it gets paid back.
 *
 * The platform refunds a shopper the moment a refund is due. It does not wait
 * for the brand to have the money, and it does not ask the shopper to chase
 * anyone. Where the brand had already been paid for that order, WIEZ is out of
 * pocket and the brand carries a debt.
 *
 * One number decides it: the brand's position in its settlement currency
 * (`loadBrandPosition`) — released earnings net of refunds, minus payouts,
 * minus manual debits and chargebacks, plus manual credits. A refund removes
 * its released money from that position once; the REFUND_CLAWBACK row records
 * why, so a brand can be shown WHAT it owes and WHY. Debt is the negative part
 * of the position. Recovery is automatic and oldest-first: whenever later
 * earnings lift the position, the oldest recorded debts are marked paid down,
 * with a statement line per payment.
 *
 * A brand carrying a debt must acknowledge it in words before accepting new
 * custom work — see `assertCustomOrderAcceptanceAllowed`.
 *
 * Lock order: callers that also hold order/escrow/refund rows take those
 * first; this service takes the Brand row, then debt rows (oldest first).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BrandBalanceAdjustmentStatus,
  BrandBalanceAdjustmentType,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { loadBrandDebtContext } from './brand-debt-query';
import {
  BRAND_SETTLEMENT_CURRENCY,
  loadBrandPosition,
} from './brand-position-query';

/** Statuses that still take money out of what a brand can withdraw. */
const ACTIVE_DEBT_STATUSES: BrandBalanceAdjustmentStatus[] = [
  BrandBalanceAdjustmentStatus.OUTSTANDING,
  BrandBalanceAdjustmentStatus.PARTIALLY_RECOVERED,
];

/** Adjustment types that are money the brand owes (credits are not debts). */
const DEBT_TYPES: BrandBalanceAdjustmentType[] = [
  BrandBalanceAdjustmentType.REFUND_CLAWBACK,
  BrandBalanceAdjustmentType.CHARGEBACK,
  BrandBalanceAdjustmentType.MANUAL_DEBIT,
];

const ANNOUNCE_BATCH = 50;

export type BrandDebtSnapshot = {
  /** Total still owed: the negative part of the brand's position. */
  outstanding: number;
  currency: string;
  /** How many separate recorded debts are still open. */
  count: number;
  /** The oldest unpaid one, which is what recovery hits first. */
  oldestAt: Date | null;
  inDebt: boolean;
};

type Amount = Prisma.Decimal | number | string;

const decimal = (value: Amount) =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));

@Injectable()
export class BrandBalanceService {
  private readonly logger = new Logger(BrandBalanceService.name);
  private announcing = false;

  constructor(
    private readonly prisma: PrismaService,
    // Optional so finance can be constructed in isolation (and in tests)
    // without dragging the notification stack in behind it.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  /** What this brand owes right now. Cheap enough to call on an accept screen. */
  async getDebtSnapshot(brandId: string): Promise<BrandDebtSnapshot> {
    return (await loadBrandDebtContext(this.prisma, brandId)).snapshot;
  }

  /** Serializes every money command for one brand. */
  async lockBrand(tx: Prisma.TransactionClient, brandId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "_id" AS id FROM "Brand" WHERE "_id" = ${brandId}::uuid FOR UPDATE`;
    if (!rows.length) throw new BadRequestException('Brand not found');
  }

  /**
   * Record a debt (or a manual credit). Called when the platform has refunded
   * money the brand was already paid, so the brand's own balance has to answer
   * for it.
   *
   * Exactly once per `sourceKey`: a refund retried, or a webhook delivered
   * twice, must not bill the brand twice for the same money. The key is
   * enforced by a unique index, so concurrent callers converge on one row.
   */
  async raiseAdjustment(
    tx: Prisma.TransactionClient,
    params: {
      brandId: string;
      type: BrandBalanceAdjustmentType;
      amount: Amount;
      currency?: string;
      reason: string;
      customOrderId?: string | null;
      orderId?: string | null;
      createdById?: string | null;
      sourceKey?: string | null;
    },
  ) {
    const amount = decimal(params.amount).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      throw new BadRequestException(
        'A balance adjustment must be a positive amount',
      );
    }
    const currency = String(params.currency ?? BRAND_SETTLEMENT_CURRENCY)
      .trim()
      .toUpperCase();
    const isSystemRaised = !params.createdById;
    if (isSystemRaised && !params.sourceKey) {
      throw new BadRequestException('A system adjustment needs a source key');
    }

    await this.lockBrand(tx, params.brandId);
    const isCredit = params.type === BrandBalanceAdjustmentType.MANUAL_CREDIT;
    const data = {
      brandId: params.brandId,
      type: params.type,
      amount,
      currency,
      reason: params.reason,
      customOrderId: params.customOrderId ?? null,
      orderId: params.orderId ?? null,
      createdById: params.createdById ?? null,
      sourceKey: params.sourceKey ?? null,
      // A credit is applied in full the moment it exists.
      ...(isCredit
        ? {
            status: BrandBalanceAdjustmentStatus.RECOVERED,
            recoveredAmount: amount,
            settledAt: new Date(),
          }
        : {}),
    };
    let row: { id: string; amount: Prisma.Decimal; currency: string };
    if (params.sourceKey) {
      await tx.brandBalanceAdjustment.createMany({
        data: [data],
        skipDuplicates: true,
      });
      row = await tx.brandBalanceAdjustment.findUniqueOrThrow({
        where: { sourceKey: params.sourceKey },
        select: { id: true, amount: true, currency: true },
      });
      if (!row.amount.equals(amount) || row.currency !== currency) {
        throw new BadRequestException('BRAND_ADJUSTMENT_SOURCE_CONFLICT');
      }
    } else {
      row = await tx.brandBalanceAdjustment.create({
        data,
        select: { id: true, amount: true, currency: true },
      });
    }

    await this.reconcileRecoveries(tx, params.brandId, currency, {
      orderId: params.orderId ?? null,
      customOrderId: params.customOrderId ?? null,
    });
    return { id: row.id };
  }

  /**
   * Mark recorded debts paid down, oldest first, until what they say is still
   * owed equals what the position says is owed. Idempotent; the caller already
   * holds (or this takes) the Brand lock, so concurrent recoveries serialize.
   */
  async reconcileRecoveries(
    tx: Prisma.TransactionClient,
    brandId: string,
    currency: string = BRAND_SETTLEMENT_CURRENCY,
    source: {
      orderId?: string | null;
      customOrderId?: string | null;
      note?: string;
    } = {},
  ): Promise<{ recovered: Prisma.Decimal; outstanding: Prisma.Decimal }> {
    await this.lockBrand(tx, brandId);
    const debts = await tx.$queryRaw<
      Array<{
        id: string;
        amount: Prisma.Decimal;
        recoveredAmount: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT id, amount, "recoveredAmount" FROM "BrandBalanceAdjustment"
      WHERE "brandId" = ${brandId}::uuid AND currency = ${currency}
        AND status::text IN (${Prisma.join(ACTIVE_DEBT_STATUSES)})
        AND type::text IN (${Prisma.join(DEBT_TYPES)})
      ORDER BY "createdAt", id FOR UPDATE
    `);
    const { position } = await loadBrandPosition(tx, brandId, currency);
    const owed = position.isNegative()
      ? position.negated()
      : new Prisma.Decimal(0);
    const recorded = debts.reduce(
      (sum, debt) => sum.plus(debt.amount.minus(debt.recoveredAmount)),
      new Prisma.Decimal(0),
    );
    let toRecover = recorded.minus(owed);
    const recovered = toRecover.greaterThan(0)
      ? toRecover
      : new Prisma.Decimal(0);
    const now = new Date();
    for (const debt of debts) {
      if (!toRecover.greaterThan(0)) break;
      const open = debt.amount.minus(debt.recoveredAmount);
      if (!open.greaterThan(0)) continue;
      const payment = Prisma.Decimal.min(open, toRecover);
      toRecover = toRecover.minus(payment);
      const nextRecovered = debt.recoveredAmount.plus(payment);
      const settled = nextRecovered.greaterThanOrEqualTo(debt.amount);
      await tx.brandBalanceAdjustment.update({
        where: { id: debt.id },
        data: {
          recoveredAmount: nextRecovered,
          status: settled
            ? BrandBalanceAdjustmentStatus.RECOVERED
            : BrandBalanceAdjustmentStatus.PARTIALLY_RECOVERED,
          settledAt: settled ? now : null,
        },
      });
      await tx.brandBalanceRecovery.create({
        data: {
          adjustmentId: debt.id,
          amount: payment,
          currency,
          orderId: source.orderId ?? null,
          customOrderId: source.customOrderId ?? null,
          // Later earnings, or earnings not yet withdrawn when the refund came.
          note: source.note ?? 'Settled from the brand balance',
        },
      });
    }
    return { recovered, outstanding: owed };
  }

  /**
   * How much of a release may be paid out now: never more than the brand's
   * position, so earnings settle any debt before anything becomes payable.
   * Partial payment is the normal case — a brand owing ₦40,000 who earns
   * ₦15,000 pays down ₦15,000 and keeps nothing.
   */
  async payableFromRelease(
    tx: Prisma.TransactionClient,
    params: { brandId: string; amount: Amount; currency?: string },
  ): Promise<{ payable: Prisma.Decimal; withheld: Prisma.Decimal }> {
    const currency = params.currency ?? BRAND_SETTLEMENT_CURRENCY;
    await this.lockBrand(tx, params.brandId);
    const amount = decimal(params.amount);
    const { position } = await loadBrandPosition(tx, params.brandId, currency);
    const capped = Prisma.Decimal.max(0, Prisma.Decimal.min(amount, position));
    return { payable: capped, withheld: amount.minus(capped) };
  }

  /**
   * Tell brand owners about committed balance changes. Runs after commit, so a
   * rolled-back refund never produces a notice; keyed by the row id, so a
   * repeated sweep or two processes never send one twice.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async announcePending(): Promise<number> {
    if (!this.notifications || this.announcing) return 0;
    this.announcing = true;
    try {
      const [debts, recoveries] = await Promise.all([
        this.prisma.brandBalanceAdjustment.findMany({
          where: { announcedAt: null },
          orderBy: { createdAt: 'asc' },
          take: ANNOUNCE_BATCH,
          select: {
            id: true,
            brandId: true,
            type: true,
            amount: true,
            currency: true,
            reason: true,
            orderId: true,
            customOrderId: true,
          },
        }),
        this.prisma.brandBalanceRecovery.findMany({
          where: { announcedAt: null },
          orderBy: { createdAt: 'asc' },
          take: ANNOUNCE_BATCH,
          select: {
            id: true,
            amount: true,
            currency: true,
            orderId: true,
            customOrderId: true,
            adjustment: { select: { brandId: true } },
          },
        }),
      ]);
      let sent = 0;
      const events = [
        ...debts.map((row) => ({
          table: 'adjustment' as const,
          id: row.id,
          brandId: row.brandId,
          direction:
            row.type === BrandBalanceAdjustmentType.MANUAL_CREDIT
              ? 'CREDIT'
              : 'DEBIT',
          amount: row.amount,
          currency: row.currency,
          reason: row.reason,
          orderId: row.orderId,
          customOrderId: row.customOrderId,
        })),
        ...recoveries.map((row) => ({
          table: 'recovery' as const,
          id: row.id,
          brandId: row.adjustment.brandId,
          direction: 'RECOVERY',
          amount: row.amount,
          currency: row.currency,
          reason: undefined as string | undefined,
          orderId: row.orderId,
          customOrderId: row.customOrderId,
        })),
      ];
      for (const event of events) {
        try {
          const { ownerId, snapshot } = await loadBrandDebtContext(
            this.prisma,
            event.brandId,
          );
          if (ownerId) {
            await this.notifications.create(
              ownerId,
              NotificationType.BRAND_BALANCE_ADJUSTED,
              {
                notificationId: event.id,
                payload: {
                  direction: event.direction,
                  amount: event.amount.toNumber(),
                  currency: event.currency,
                  outstanding: snapshot.outstanding,
                  reason: event.reason,
                  customOrderId: event.customOrderId ?? undefined,
                  orderId: event.orderId ?? undefined,
                  targetUrl: '/studio/finance',
                },
              },
            );
          }
          const mark = {
            where: { id: event.id, announcedAt: null },
            data: { announcedAt: new Date() },
          };
          if (event.table === 'adjustment')
            await this.prisma.brandBalanceAdjustment.updateMany(mark);
          else await this.prisma.brandBalanceRecovery.updateMany(mark);
          sent += 1;
        } catch (error) {
          this.logger.warn(
            `Balance notice ${event.id} not yet delivered: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return sent;
    } finally {
      this.announcing = false;
    }
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
        amount: adjustment.amount.toNumber(),
        recoveredAmount: adjustment.recoveredAmount.toNumber(),
        outstanding: adjustment.amount
          .minus(adjustment.recoveredAmount)
          .toNumber(),
        currency: adjustment.currency,
        reason: adjustment.reason,
        customOrderId: adjustment.customOrderId,
        orderId: adjustment.orderId,
        settledAt: adjustment.settledAt,
        createdAt: adjustment.createdAt,
        recoveries: adjustment.recoveries.map((recovery) => ({
          id: recovery.id,
          amount: recovery.amount.toNumber(),
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
