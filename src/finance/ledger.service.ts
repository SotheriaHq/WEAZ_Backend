import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

const LedgerAccountType = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
} as const;

type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

const LedgerEntryDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;

type LedgerEntryDirection = (typeof LedgerEntryDirection)[keyof typeof LedgerEntryDirection];

const LedgerTransactionType = {
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  ESCROW_RELEASE: 'ESCROW_RELEASE',
  PAYOUT_DISBURSED: 'PAYOUT_DISBURSED',
  REFUND_ISSUED: 'REFUND_ISSUED',
  REVERSAL: 'REVERSAL',
} as const;

type LedgerTransactionType = (typeof LedgerTransactionType)[keyof typeof LedgerTransactionType];

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
    const existing = await (tx as any).ledgerTransaction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      include: {
        entries: {
          include: {
            account: true,
          },
        },
      },
    });
    if (existing) {
      return existing;
    }

    const roundedTotal = this.roundMoney(params.totalAmount);
    const debitTotal = this.roundMoney(
      params.lines
        .filter((line) => line.direction === LedgerEntryDirection.DEBIT)
        .reduce((sum, line) => sum + this.roundMoney(line.amount), 0),
    );
    const creditTotal = this.roundMoney(
      params.lines
        .filter((line) => line.direction === LedgerEntryDirection.CREDIT)
        .reduce((sum, line) => sum + this.roundMoney(line.amount), 0),
    );

    if (debitTotal !== creditTotal) {
      throw new BadRequestException('LEDGER_UNBALANCED_TRANSACTION');
    }

    const transaction = await (tx as any).ledgerTransaction.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        type: params.type,
        description: params.description,
        referenceType: params.referenceType ?? null,
        referenceId: params.referenceId ?? null,
        totalAmount: new Prisma.Decimal(roundedTotal.toFixed(2)),
        currency: params.currency,
        baseCurrency: params.baseCurrency ?? params.currency,
        baseCurrencyAmount: new Prisma.Decimal(
          this.roundMoney(params.baseCurrencyAmount ?? roundedTotal).toFixed(2),
        ),
        fxRateSnapshotId: params.fxRateSnapshotId ?? null,
        metadata: params.metadata ?? Prisma.JsonNull,
        createdById: params.createdById ?? null,
      },
    });

    for (const line of params.lines) {
      const amount = this.roundMoney(line.amount);
      if (amount <= 0) {
        continue;
      }

      const account = await this.ensureAccount(tx, line);
      const nextBalance = this.roundMoney(
        Number(account.currentBalance) +
          this.getBalanceDelta(account.type, line.direction, amount),
      );

      await (tx as any).ledgerAccount.update({
        where: { id: account.id },
        data: {
          currentBalance: new Prisma.Decimal(nextBalance.toFixed(2)),
        },
      });

      await (tx as any).ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: account.id,
          direction: line.direction,
          amount: new Prisma.Decimal(amount.toFixed(2)),
          balanceAfter: new Prisma.Decimal(nextBalance.toFixed(2)),
        },
      });
    }

    return (tx as any).ledgerTransaction.findUnique({
      where: { id: transaction.id },
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
        (hold.secondReleasedAt ? Number(hold.secondReleaseCommissionAmount) : 0),
    );
    const releasedNet = this.roundMoney(
      (hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount) : 0) +
        (hold.secondReleasedAt ? Number(hold.secondReleaseNetAmount) : 0),
    );
    const unreleasedGross = this.roundMoney(Number(hold.totalAmount) - releasedGross);

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
        ...(params.referenceType ? { referenceType: params.referenceType } : {}),
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

  private async ensureAccount(tx: Prisma.TransactionClient, line: LedgerLine) {
    const existing = await (tx as any).ledgerAccount.findUnique({
      where: { code: line.code },
    });
    if (existing) {
      return existing;
    }

    return (tx as any).ledgerAccount.create({
      data: {
        code: line.code,
        name: line.name,
        type: line.type,
        subType: line.subType,
        entityType: line.entityType ?? null,
        entityId: line.entityId ?? null,
        currency: 'NGN',
        currentBalance: new Prisma.Decimal('0.00'),
        isSystemAccount: Boolean(line.isSystemAccount),
        isActive: true,
      },
    });
  }

  private getBrandWalletCode(brandId: string) {
    return `BRAND_WALLET:${brandId}`;
  }

  private getBalanceDelta(
    accountType: LedgerAccountType,
    direction: LedgerEntryDirection,
    amount: number,
  ) {
    const isDebitIncrease =
      accountType === LedgerAccountType.ASSET || accountType === LedgerAccountType.EXPENSE;

    if (direction === LedgerEntryDirection.DEBIT) {
      return isDebitIncrease ? amount : -amount;
    }

    return isDebitIncrease ? -amount : amount;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
