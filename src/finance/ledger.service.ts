import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';

const LedgerAccountType = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
} as const;

type LedgerAccountType =
  (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

const LedgerEntryDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;

type LedgerEntryDirection =
  (typeof LedgerEntryDirection)[keyof typeof LedgerEntryDirection];

const LedgerTransactionType = {
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  ESCROW_RELEASE: 'ESCROW_RELEASE',
  PAYOUT_DISBURSED: 'PAYOUT_DISBURSED',
  REFUND_ISSUED: 'REFUND_ISSUED',
  REVERSAL: 'REVERSAL',
} as const;

type LedgerTransactionType =
  (typeof LedgerTransactionType)[keyof typeof LedgerTransactionType];

type LedgerLine = {
  code: string;
  name: string;
  type: LedgerAccountType;
  subType: string;
  entityType?: string;
  entityId?: string;
  isSystemAccount?: boolean;
  direction: LedgerEntryDirection;
  amount: number;
};

type PostLedgerTransactionParams = {
  idempotencyKey: string;
  type: LedgerTransactionType;
  description: string;
  referenceType?: string;
  referenceId?: string;
  totalAmount: number;
  currency: string;
  baseCurrency?: string;
  baseCurrencyAmount?: number;
  fxRateSnapshotId?: string | null;
  metadata?: Prisma.InputJsonValue;
  createdById?: string | null;
  lines: LedgerLine[];
};

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async postTransaction(
    tx: Prisma.TransactionClient,
    params: PostLedgerTransactionParams,
  ) {
    const roundedTotal = this.ledgerMoney(params.totalAmount);
    const lines = params.lines.map((line) => ({
      ...line,
      amount: this.ledgerMoney(line.amount),
    }));
    let debitTotal = new Prisma.Decimal(0);
    let creditTotal = new Prisma.Decimal(0);
    for (const line of lines) {
      if (line.direction === LedgerEntryDirection.DEBIT) {
        debitTotal = debitTotal.plus(line.amount);
      } else if (line.direction === LedgerEntryDirection.CREDIT) {
        creditTotal = creditTotal.plus(line.amount);
      } else {
        throw new BadRequestException('LEDGER_INVALID_DIRECTION');
      }
    }

    if (!debitTotal.equals(creditTotal)) {
      throw new BadRequestException('LEDGER_UNBALANCED_TRANSACTION');
    }

    // A uniqueness violation aborts a PostgreSQL transaction, so do not catch
    // P2002 and continue. ON CONFLICT elects one writer without aborting it.
    const transactionId = randomUUID();
    const claim = await tx.ledgerTransaction.createMany({
      skipDuplicates: true,
      data: {
        id: transactionId,
        idempotencyKey: params.idempotencyKey,
        type: params.type,
        description: params.description,
        referenceType: params.referenceType ?? null,
        referenceId: params.referenceId ?? null,
        totalAmount: roundedTotal,
        currency: params.currency,
        baseCurrency: params.baseCurrency ?? params.currency,
        baseCurrencyAmount: this.ledgerMoney(
          params.baseCurrencyAmount ?? params.totalAmount,
        ),
        fxRateSnapshotId: params.fxRateSnapshotId ?? null,
        metadata: params.metadata ?? Prisma.JsonNull,
        createdById: params.createdById ?? null,
      },
    });
    if (claim.count === 0) {
      // Separate READ COMMITTED statement sees the winner after INSERT waits.
      const existing = await tx.ledgerTransaction.findUniqueOrThrow({
        where: { idempotencyKey: params.idempotencyKey },
        include: { entries: { include: { account: true } } },
      });
      const signature = (
        items: Array<{
          code: string;
          direction: string;
          amount: Prisma.Decimal;
        }>,
      ) =>
        items
          .filter((item) => item.amount.greaterThan(0))
          .map(
            (item) =>
              `${item.code}|${item.direction}|${item.amount.toFixed(2)}`,
          )
          .sort()
          .join('\n');
      if (
        existing.type !== params.type ||
        existing.currency !== params.currency ||
        existing.referenceType !== (params.referenceType ?? null) ||
        existing.referenceId !== (params.referenceId ?? null) ||
        !existing.totalAmount.equals(roundedTotal) ||
        signature(
          existing.entries.map((entry) => ({
            ...entry,
            code: entry.account.code,
          })),
        ) !== signature(lines)
      ) {
        throw new BadRequestException('LEDGER_IDEMPOTENCY_CONFLICT');
      }
      return existing;
    }

    const positiveLines = lines.filter((line) => line.amount.greaterThan(0));
    const definitions = new Map<string, LedgerLine>();
    for (const line of positiveLines) {
      const previous = definitions.get(line.code);
      if (previous && !this.sameAccountDefinition(previous, line)) {
        throw new BadRequestException('LEDGER_ACCOUNT_DEFINITION_MISMATCH');
      }
      definitions.set(line.code, { ...line, amount: 0 });
    }
    const codes = [...definitions.keys()].sort();
    if (codes.length > 0) {
      const existing = await tx.ledgerAccount.findMany({
        where: { code: { in: codes } },
        select: { code: true },
      });
      const existingCodes = new Set(existing.map((account) => account.code));
      const missing = codes.filter((code) => !existingCodes.has(code));
      if (missing.length > 0) {
        await tx.ledgerAccount.createMany({
          skipDuplicates: true,
          data: missing.map((code) => {
            const line = definitions.get(code)!;
            return {
              code,
              name: line.name,
              type: line.type,
              subType: line.subType,
              entityType: line.entityType ?? null,
              entityId: line.entityId ?? null,
              currency: 'NGN',
              currentBalance: new Prisma.Decimal(0),
              isSystemAccount: Boolean(line.isSystemAccount),
              isActive: true,
            };
          }),
        });
      }
      // All accounts are locked in the same code order, regardless of debit /
      // credit order. A separate statement reads balances after any wait.
      const accounts = await tx.$queryRaw<
        Array<{
          id: string;
          code: string;
          type: LedgerAccountType;
          subType: string;
          entityType: string | null;
          entityId: string | null;
          isSystemAccount: boolean;
          currentBalance: Prisma.Decimal;
        }>
      >(Prisma.sql`
        SELECT "id", "code", "type", "subType", "entityType", "entityId",
               "isSystemAccount", "currentBalance"
        FROM "LedgerAccount" WHERE "code" IN (${Prisma.join(codes)})
        ORDER BY "code" FOR UPDATE
      `);
      if (accounts.length !== codes.length) {
        throw new BadRequestException('LEDGER_ACCOUNT_LOCK_FAILED');
      }
      for (const account of accounts) {
        if (
          !this.sameAccountDefinition(account, definitions.get(account.code)!)
        ) {
          throw new BadRequestException('LEDGER_ACCOUNT_DEFINITION_MISMATCH');
        }
      }
      const byCode = new Map(
        accounts.map((account) => [account.code, account]),
      );
      const entries: Prisma.LedgerEntryCreateManyInput[] = [];
      for (const line of positiveLines) {
        const account = byCode.get(line.code)!;
        const nextBalance = account.currentBalance.plus(
          this.getBalanceDelta(account.type, line.direction, line.amount),
        );
        if (nextBalance.abs().greaterThan('9999999999999999.99')) {
          throw new BadRequestException('LEDGER_BALANCE_OUT_OF_RANGE');
        }
        account.currentBalance = nextBalance;
        entries.push({
          transactionId,
          accountId: account.id,
          direction: line.direction,
          amount: line.amount,
          balanceAfter: nextBalance,
        });
      }
      const balances = accounts.map(
        (account) => Prisma.sql`
        (${account.id}::uuid, ${account.currentBalance.toFixed(2)}::numeric)
      `,
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "LedgerAccount" AS account
        SET "currentBalance" = balances.amount,
            "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        FROM (VALUES ${Prisma.join(balances)}) AS balances(id, amount)
        WHERE account."id" = balances.id
      `);
      await tx.ledgerEntry.createMany({ data: entries });
    }

    return tx.ledgerTransaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: {
        entries: {
          include: {
            account: true,
          },
        },
      },
    });
  }

  async postStandardOrderPaymentReceived(
    tx: Prisma.TransactionClient,
    hold: {
      orderId: string | null;
      totalAmount: Prisma.Decimal;
      currency: string;
    },
  ) {
    if (!hold.orderId) {
      return null;
    }

    return this.postTransaction(tx, {
      idempotencyKey: `ledger:order:${hold.orderId}:payment_received`,
      type: LedgerTransactionType.PAYMENT_RECEIVED,
      description: `Payment received for order ${hold.orderId}`,
      referenceType: 'Order',
      referenceId: hold.orderId,
      totalAmount: Number(hold.totalAmount),
      currency: hold.currency,
      lines: [
        {
          code: 'SYSTEM:GATEWAY_RECEIVABLES',
          name: 'Gateway Receivables',
          type: LedgerAccountType.ASSET,
          subType: 'GATEWAY_RECEIVABLES',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: Number(hold.totalAmount),
        },
        {
          code: 'SYSTEM:STANDARD_ORDER_ESCROW',
          name: 'Standard Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'STANDARD_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(hold.totalAmount),
        },
      ],
    });
  }

  async postStandardOrderShipmentRelease(
    tx: Prisma.TransactionClient,
    hold: {
      orderId: string | null;
      brandId: string;
      currency: string;
      firstReleaseAmount: Prisma.Decimal;
      firstReleaseCommissionAmount: Prisma.Decimal;
      firstReleaseNetAmount: Prisma.Decimal;
    },
  ) {
    if (!hold.orderId) {
      return null;
    }

    return this.postTransaction(tx, {
      idempotencyKey: `ledger:order:${hold.orderId}:shipment_release`,
      type: LedgerTransactionType.ESCROW_RELEASE,
      description: `Shipment release for order ${hold.orderId}`,
      referenceType: 'Order',
      referenceId: hold.orderId,
      totalAmount: Number(hold.firstReleaseAmount),
      currency: hold.currency,
      lines: [
        {
          code: 'SYSTEM:STANDARD_ORDER_ESCROW',
          name: 'Standard Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'STANDARD_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: Number(hold.firstReleaseAmount),
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: LedgerAccountType.REVENUE,
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(hold.firstReleaseCommissionAmount),
        },
        {
          code: this.getBrandWalletCode(hold.brandId),
          name: `Brand Wallet ${hold.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: hold.brandId,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(hold.firstReleaseNetAmount),
        },
      ],
    });
  }

  async postStandardOrderFinalRelease(
    tx: Prisma.TransactionClient,
    hold: {
      orderId: string | null;
      brandId: string;
      currency: string;
      secondReleaseAmount: Prisma.Decimal;
      secondReleaseCommissionAmount: Prisma.Decimal;
      secondReleaseNetAmount: Prisma.Decimal;
    },
  ) {
    if (!hold.orderId) {
      return null;
    }

    return this.postTransaction(tx, {
      idempotencyKey: `ledger:order:${hold.orderId}:final_release`,
      type: LedgerTransactionType.ESCROW_RELEASE,
      description: `Final escrow release for order ${hold.orderId}`,
      referenceType: 'Order',
      referenceId: hold.orderId,
      totalAmount: Number(hold.secondReleaseAmount),
      currency: hold.currency,
      lines: [
        {
          code: 'SYSTEM:STANDARD_ORDER_ESCROW',
          name: 'Standard Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'STANDARD_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: Number(hold.secondReleaseAmount),
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: LedgerAccountType.REVENUE,
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(hold.secondReleaseCommissionAmount),
        },
        {
          code: this.getBrandWalletCode(hold.brandId),
          name: `Brand Wallet ${hold.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: hold.brandId,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(hold.secondReleaseNetAmount),
        },
      ],
    });
  }

  async postCustomOrderPaymentReceived(
    tx: Prisma.TransactionClient,
    params: {
      customOrderId: string;
      totalAmount: number;
      currency: string;
    },
  ) {
    return this.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${params.customOrderId}:payment_received`,
      type: LedgerTransactionType.PAYMENT_RECEIVED,
      description: `Payment received for custom order ${params.customOrderId}`,
      referenceType: 'CustomOrder',
      referenceId: params.customOrderId,
      totalAmount: params.totalAmount,
      currency: params.currency,
      lines: [
        {
          code: 'SYSTEM:GATEWAY_RECEIVABLES',
          name: 'Gateway Receivables',
          type: LedgerAccountType.ASSET,
          subType: 'GATEWAY_RECEIVABLES',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: params.totalAmount,
        },
        {
          code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
          name: 'Custom Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'CUSTOM_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: params.totalAmount,
        },
      ],
    });
  }

  async postCustomOrderImmediateRelease(
    tx: Prisma.TransactionClient,
    params: {
      customOrderId: string;
      brandId: string;
      currency: string;
      amount: number;
      commissionAmount: number;
      netBrandAmount: number;
    },
  ) {
    return this.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${params.customOrderId}:acceptance_release`,
      type: LedgerTransactionType.ESCROW_RELEASE,
      description: `Immediate custom-order release for ${params.customOrderId}`,
      referenceType: 'CustomOrder',
      referenceId: params.customOrderId,
      totalAmount: params.amount,
      currency: params.currency,
      lines: [
        {
          code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
          name: 'Custom Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'CUSTOM_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: params.amount,
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: LedgerAccountType.REVENUE,
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: params.commissionAmount,
        },
        {
          code: this.getBrandWalletCode(params.brandId),
          name: `Brand Wallet ${params.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: params.brandId,
          direction: LedgerEntryDirection.CREDIT,
          amount: params.netBrandAmount,
        },
      ],
    });
  }

  async postCustomOrderFinalRelease(
    tx: Prisma.TransactionClient,
    params: {
      customOrderId: string;
      brandId: string;
      currency: string;
      amount: number;
      commissionAmount: number;
      netBrandAmount: number;
    },
  ) {
    return this.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${params.customOrderId}:final_release`,
      type: LedgerTransactionType.ESCROW_RELEASE,
      description: `Final custom-order release for ${params.customOrderId}`,
      referenceType: 'CustomOrder',
      referenceId: params.customOrderId,
      totalAmount: params.amount,
      currency: params.currency,
      lines: [
        {
          code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
          name: 'Custom Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'CUSTOM_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: params.amount,
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: LedgerAccountType.REVENUE,
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: params.commissionAmount,
        },
        {
          code: this.getBrandWalletCode(params.brandId),
          name: `Brand Wallet ${params.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: params.brandId,
          direction: LedgerEntryDirection.CREDIT,
          amount: params.netBrandAmount,
        },
      ],
    });
  }

  async postCustomOrderRefund(
    tx: Prisma.TransactionClient,
    params: {
      customOrderId: string;
      brandId: string;
      currency: string;
      totalAmount: number;
      releasedCommission: number;
      releasedNet: number;
      unreleasedGross: number;
    },
  ) {
    const lines: LedgerLine[] = [];

    if (params.unreleasedGross > 0) {
      lines.push({
        code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
        name: 'Custom Order Escrow',
        type: LedgerAccountType.LIABILITY,
        subType: 'CUSTOM_ORDER_ESCROW',
        isSystemAccount: true,
        direction: LedgerEntryDirection.DEBIT,
        amount: params.unreleasedGross,
      });
    }

    if (params.releasedCommission > 0) {
      lines.push({
        code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
        name: 'Platform Commission Revenue',
        type: LedgerAccountType.REVENUE,
        subType: 'PLATFORM_COMMISSION',
        isSystemAccount: true,
        direction: LedgerEntryDirection.DEBIT,
        amount: params.releasedCommission,
      });
    }

    if (params.releasedNet > 0) {
      lines.push({
        code: this.getBrandWalletCode(params.brandId),
        name: `Brand Wallet ${params.brandId}`,
        type: LedgerAccountType.LIABILITY,
        subType: 'BRAND_AVAILABLE',
        entityType: 'BRAND',
        entityId: params.brandId,
        direction: LedgerEntryDirection.DEBIT,
        amount: params.releasedNet,
      });
    }

    lines.push({
      code: 'SYSTEM:GATEWAY_RECEIVABLES',
      name: 'Gateway Receivables',
      type: LedgerAccountType.ASSET,
      subType: 'GATEWAY_RECEIVABLES',
      isSystemAccount: true,
      direction: LedgerEntryDirection.CREDIT,
      amount: params.totalAmount,
    });

    return this.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${params.customOrderId}:refund`,
      type: LedgerTransactionType.REFUND_ISSUED,
      description: `Refund issued for custom order ${params.customOrderId}`,
      referenceType: 'CustomOrder',
      referenceId: params.customOrderId,
      totalAmount: params.totalAmount,
      currency: params.currency,
      lines,
    });
  }

  async postStandardOrderRefund(
    tx: Prisma.TransactionClient,
    hold: {
      orderId: string | null;
      brandId: string;
      currency: string;
      totalAmount: Prisma.Decimal;
      firstReleasedAt: Date | null;
      firstReleaseAmount: Prisma.Decimal;
      firstReleaseCommissionAmount: Prisma.Decimal;
      firstReleaseNetAmount: Prisma.Decimal;
      secondReleasedAt: Date | null;
      secondReleaseAmount: Prisma.Decimal;
      secondReleaseCommissionAmount: Prisma.Decimal;
      secondReleaseNetAmount: Prisma.Decimal;
    },
  ) {
    if (!hold.orderId) {
      return null;
    }

    const releasedGross = this.roundMoney(
      (hold.firstReleasedAt ? Number(hold.firstReleaseAmount) : 0) +
        (hold.secondReleasedAt ? Number(hold.secondReleaseAmount) : 0),
    );
    const releasedCommission = this.roundMoney(
      (hold.firstReleasedAt ? Number(hold.firstReleaseCommissionAmount) : 0) +
        (hold.secondReleasedAt
          ? Number(hold.secondReleaseCommissionAmount)
          : 0),
    );
    const releasedNet = this.roundMoney(
      (hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount) : 0) +
        (hold.secondReleasedAt ? Number(hold.secondReleaseNetAmount) : 0),
    );
    const unreleasedGross = this.roundMoney(
      Number(hold.totalAmount) - releasedGross,
    );

    const lines: LedgerLine[] = [];

    if (unreleasedGross > 0) {
      lines.push({
        code: 'SYSTEM:STANDARD_ORDER_ESCROW',
        name: 'Standard Order Escrow',
        type: LedgerAccountType.LIABILITY,
        subType: 'STANDARD_ORDER_ESCROW',
        isSystemAccount: true,
        direction: LedgerEntryDirection.DEBIT,
        amount: unreleasedGross,
      });
    }

    if (releasedCommission > 0) {
      lines.push({
        code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
        name: 'Platform Commission Revenue',
        type: LedgerAccountType.REVENUE,
        subType: 'PLATFORM_COMMISSION',
        isSystemAccount: true,
        direction: LedgerEntryDirection.DEBIT,
        amount: releasedCommission,
      });
    }

    if (releasedNet > 0) {
      lines.push({
        code: this.getBrandWalletCode(hold.brandId),
        name: `Brand Wallet ${hold.brandId}`,
        type: LedgerAccountType.LIABILITY,
        subType: 'BRAND_AVAILABLE',
        entityType: 'BRAND',
        entityId: hold.brandId,
        direction: LedgerEntryDirection.DEBIT,
        amount: releasedNet,
      });
    }

    lines.push({
      code: 'SYSTEM:GATEWAY_RECEIVABLES',
      name: 'Gateway Receivables',
      type: LedgerAccountType.ASSET,
      subType: 'GATEWAY_RECEIVABLES',
      isSystemAccount: true,
      direction: LedgerEntryDirection.CREDIT,
      amount: Number(hold.totalAmount),
    });

    return this.postTransaction(tx, {
      idempotencyKey: `ledger:order:${hold.orderId}:refund`,
      type: LedgerTransactionType.REFUND_ISSUED,
      description: `Refund issued for order ${hold.orderId}`,
      referenceType: 'Order',
      referenceId: hold.orderId,
      totalAmount: Number(hold.totalAmount),
      currency: hold.currency,
      lines,
    });
  }

  async postPayoutDisbursed(
    tx: Prisma.TransactionClient,
    payout: {
      id: string;
      brandId: string;
      amount: Prisma.Decimal;
      currency: string;
    },
  ) {
    return this.postTransaction(tx, {
      idempotencyKey: `ledger:payout:${payout.id}:paid`,
      type: LedgerTransactionType.PAYOUT_DISBURSED,
      description: `Payout disbursed for brand ${payout.brandId}`,
      referenceType: 'Payout',
      referenceId: payout.id,
      totalAmount: Number(payout.amount),
      currency: payout.currency,
      lines: [
        {
          code: this.getBrandWalletCode(payout.brandId),
          name: `Brand Wallet ${payout.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: payout.brandId,
          direction: LedgerEntryDirection.DEBIT,
          amount: Number(payout.amount),
        },
        {
          code: 'SYSTEM:BANK_SETTLEMENT',
          name: 'Bank Settlement Account',
          type: LedgerAccountType.ASSET,
          subType: 'BANK_SETTLEMENT',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: Number(payout.amount),
        },
      ],
    });
  }

  async listTransactions(params: {
    type?: LedgerTransactionType;
    referenceType?: string;
    referenceId?: string;
    take?: number;
  }) {
    return (this.prisma as any).ledgerTransaction.findMany({
      where: {
        ...(params.type ? { type: params.type } : {}),
        ...(params.referenceType
          ? { referenceType: params.referenceType }
          : {}),
        ...(params.referenceId ? { referenceId: params.referenceId } : {}),
      },
      take: Math.min(params.take ?? 50, 200),
      orderBy: { createdAt: 'desc' },
      include: {
        entries: {
          include: {
            account: true,
          },
        },
      },
    });
  }

  private sameAccountDefinition(
    left: Pick<
      LedgerLine,
      'type' | 'subType' | 'entityType' | 'entityId' | 'isSystemAccount'
    >,
    right: Pick<
      LedgerLine,
      'type' | 'subType' | 'entityType' | 'entityId' | 'isSystemAccount'
    >,
  ) {
    return (
      left.type === right.type &&
      left.subType === right.subType &&
      (left.entityType ?? null) === (right.entityType ?? null) &&
      (left.entityId ?? null) === (right.entityId ?? null) &&
      Boolean(left.isSystemAccount) === Boolean(right.isSystemAccount)
    );
  }

  private ledgerMoney(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new BadRequestException('LEDGER_INVALID_AMOUNT');
    }
    const amount = new Prisma.Decimal(value).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
    if (amount.greaterThan('9999999999999999.99')) {
      throw new BadRequestException('LEDGER_AMOUNT_OUT_OF_RANGE');
    }
    return amount;
  }

  private getBrandWalletCode(brandId: string) {
    return `BRAND_WALLET:${brandId}`;
  }

  private getBalanceDelta(
    accountType: LedgerAccountType,
    direction: LedgerEntryDirection,
    amount: Prisma.Decimal,
  ) {
    const isDebitIncrease =
      accountType === LedgerAccountType.ASSET ||
      accountType === LedgerAccountType.EXPENSE;

    if (direction === LedgerEntryDirection.DEBIT) {
      return isDebitIncrease ? amount : amount.negated();
    }

    return isDebitIncrease ? amount.negated() : amount;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
