import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

const FINANCIAL_DOCUMENT_TYPE = {
  BUYER_RECEIPT: 'BUYER_RECEIPT',
  BRAND_SETTLEMENT_STATEMENT: 'BRAND_SETTLEMENT_STATEMENT',
  PLATFORM_COMMISSION_INVOICE: 'PLATFORM_COMMISSION_INVOICE',
  CREDIT_NOTE: 'CREDIT_NOTE',
} as const;

type FinancialDocumentType =
  (typeof FINANCIAL_DOCUMENT_TYPE)[keyof typeof FINANCIAL_DOCUMENT_TYPE];

type DocumentClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class FinancialDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async issueBuyerReceipt(
    tx: Prisma.TransactionClient,
    params: {
      paymentAttemptId: string;
      orderIds?: string[];
      customOrderId?: string | null;
      currency: string;
      grossAmount: number;
      settlementCurrency?: string | null;
      settlementAmount?: number | null;
      issuedToName?: string | null;
      lineItems: Array<{ label: string; amount: number }>;
    },
  ) {
    const documents = (tx as any).financialDocument;
    const existing = await documents.findFirst({
      where: {
        type: FINANCIAL_DOCUMENT_TYPE.BUYER_RECEIPT,
        paymentAttemptId: params.paymentAttemptId,
      },
    });
    if (existing) {
      return existing;
    }

    const documentNumber = this.buildDocumentNumber('RCPT');
    return documents.create({
      data: {
        type: FINANCIAL_DOCUMENT_TYPE.BUYER_RECEIPT,
        documentNumber,
        paymentAttemptId: params.paymentAttemptId,
        orderId: params.orderIds?.[0] ?? null,
        customOrderId: params.customOrderId ?? null,
        currency: params.currency,
        grossAmount: new Prisma.Decimal(params.grossAmount.toFixed(2)),
        metadataJson: {
          orderIds: params.orderIds ?? [],
          lineItems: params.lineItems,
          issuedToName: params.issuedToName ?? null,
          settlementCurrency: params.settlementCurrency ?? params.currency,
          settlementAmount: params.settlementAmount ?? params.grossAmount,
        },
        contentHtml: this.renderBuyerReceiptHtml(documentNumber, params),
      },
    });
  }

  async issuePayoutSettlementStatement(
    tx: Prisma.TransactionClient,
    params: {
      payoutId: string;
      brandId: string;
      brandName?: string | null;
      currency: string;
      amount: number;
    },
  ) {
    const documents = (tx as any).financialDocument;
    const existing = await documents.findFirst({
      where: {
        type: FINANCIAL_DOCUMENT_TYPE.BRAND_SETTLEMENT_STATEMENT,
        payoutId: params.payoutId,
      },
    });
    if (existing) {
      return existing;
    }

    const coverage = await this.buildPayoutCoverage(tx, params.brandId, params.amount);
    const documentNumber = this.buildDocumentNumber('STMT');

    return documents.create({
      data: {
        type: FINANCIAL_DOCUMENT_TYPE.BRAND_SETTLEMENT_STATEMENT,
        documentNumber,
        payoutId: params.payoutId,
        currency: params.currency,
        grossAmount: new Prisma.Decimal(params.amount.toFixed(2)),
        netAmount: new Prisma.Decimal(params.amount.toFixed(2)),
        commissionAmount: new Prisma.Decimal(coverage.commissionAmount.toFixed(2)),
        metadataJson: {
          brandId: params.brandId,
          brandName: params.brandName ?? null,
          sourceItems: coverage.items,
        },
        contentHtml: this.renderSettlementStatementHtml(documentNumber, params, coverage.items),
      },
    });
  }

  async issueCommissionInvoice(
    tx: Prisma.TransactionClient,
    params: {
      payoutId: string;
      brandId: string;
      brandName?: string | null;
      currency: string;
      amount: number;
    },
  ) {
    const documents = (tx as any).financialDocument;
    const existing = await documents.findFirst({
      where: {
        type: FINANCIAL_DOCUMENT_TYPE.PLATFORM_COMMISSION_INVOICE,
        payoutId: params.payoutId,
      },
    });
    if (existing) {
      return existing;
    }

    const coverage = await this.buildPayoutCoverage(tx, params.brandId, params.amount);
    const documentNumber = this.buildDocumentNumber('COMM');

    return documents.create({
      data: {
        type: FINANCIAL_DOCUMENT_TYPE.PLATFORM_COMMISSION_INVOICE,
        documentNumber,
        payoutId: params.payoutId,
        currency: params.currency,
        grossAmount: new Prisma.Decimal(coverage.grossAmount.toFixed(2)),
        commissionAmount: new Prisma.Decimal(coverage.commissionAmount.toFixed(2)),
        netAmount: new Prisma.Decimal(coverage.netAmount.toFixed(2)),
        metadataJson: {
          brandId: params.brandId,
          brandName: params.brandName ?? null,
          sourceItems: coverage.items,
        },
        contentHtml: this.renderCommissionInvoiceHtml(documentNumber, params, coverage.items),
      },
    });
  }

  async listDocuments(params?: {
    type?: FinancialDocumentType;
    payoutId?: string;
    paymentAttemptId?: string;
    take?: number;
  }) {
    return (this.prisma as any).financialDocument.findMany({
      where: {
        ...(params?.type ? { type: params.type } : {}),
        ...(params?.payoutId ? { payoutId: params.payoutId } : {}),
        ...(params?.paymentAttemptId ? { paymentAttemptId: params.paymentAttemptId } : {}),
      },
      orderBy: { issuedAt: 'desc' },
      take: Math.min(params?.take ?? 50, 200),
    });
  }

  async getDocument(id: string) {
    return (this.prisma as any).financialDocument.findUnique({ where: { id } });
  }

  private async buildPayoutCoverage(
    client: DocumentClient,
    brandId: string,
    targetNetAmount: number,
  ) {
    const priorStatements = await (client as any).financialDocument.findMany({
      where: {
        type: {
          in: [
            FINANCIAL_DOCUMENT_TYPE.BRAND_SETTLEMENT_STATEMENT,
            FINANCIAL_DOCUMENT_TYPE.PLATFORM_COMMISSION_INVOICE,
          ],
        },
        status: 'GENERATED',
      },
      select: { metadataJson: true },
    });

    const usedReferenceKeys = new Set<string>();
    for (const statement of priorStatements) {
      const metadata = this.asObject(statement.metadataJson);
      const sourceItems = Array.isArray(metadata?.sourceItems) ? metadata.sourceItems : [];
      for (const item of sourceItems) {
        const referenceKey = String((item as Record<string, unknown>).referenceKey ?? '');
        if (referenceKey) {
          usedReferenceKeys.add(referenceKey);
        }
      }
    }

    const releaseTransactions = await (client as any).ledgerTransaction.findMany({
      where: {
        type: 'ESCROW_RELEASE',
        entries: {
          some: {
            direction: 'CREDIT',
            account: {
              subType: 'BRAND_AVAILABLE',
              entityId: brandId,
            },
          },
        },
      },
      include: {
        entries: {
          include: {
            account: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    let remaining = this.roundMoney(targetNetAmount);
    let grossAmount = 0;
    let commissionAmount = 0;
    let netAmount = 0;
    const items: Array<{
      referenceKey: string;
      referenceType: string | null;
      referenceId: string | null;
      label: string;
      grossAmount: number;
      commissionAmount: number;
      netAmount: number;
    }> = [];

    for (const transaction of releaseTransactions) {
      if (remaining <= 0) {
        break;
      }

      const referenceKey = `${transaction.referenceType ?? 'Unknown'}:${transaction.referenceId ?? transaction.id}`;
      if (usedReferenceKeys.has(referenceKey)) {
        continue;
      }

      const brandCreditEntry = transaction.entries.find(
        (entry: any) =>
          entry.direction === 'CREDIT' &&
          entry.account.subType === 'BRAND_AVAILABLE' &&
          entry.account.entityId === brandId,
      );
      if (!brandCreditEntry) {
        continue;
      }

      const transactionNet = Number(brandCreditEntry.amount);
      const transactionCommission = this.roundMoney(
        transaction.entries
          .filter(
            (entry: any) =>
              entry.direction === 'CREDIT' &&
              entry.account.subType === 'PLATFORM_COMMISSION',
          )
          .reduce((sum: number, entry: any) => sum + Number(entry.amount), 0),
      );
      const transactionGross = this.roundMoney(transactionNet + transactionCommission);
      const allocationNet = this.roundMoney(Math.min(transactionNet, remaining));
      const ratio = transactionNet > 0 ? allocationNet / transactionNet : 0;
      const allocationCommission = this.roundMoney(transactionCommission * ratio);
      const allocationGross = this.roundMoney(transactionGross * ratio);

      grossAmount = this.roundMoney(grossAmount + allocationGross);
      commissionAmount = this.roundMoney(commissionAmount + allocationCommission);
      netAmount = this.roundMoney(netAmount + allocationNet);
      remaining = this.roundMoney(remaining - allocationNet);

      items.push({
        referenceKey,
        referenceType: transaction.referenceType ?? null,
        referenceId: transaction.referenceId ?? null,
        label: `${transaction.referenceType ?? 'Release'} ${String(
          transaction.referenceId ?? transaction.id,
        ).slice(0, 8)}`,
        grossAmount: allocationGross,
        commissionAmount: allocationCommission,
        netAmount: allocationNet,
      });
    }

    if (remaining > 0) {
      items.push({
        referenceKey: `UNALLOCATED:${brandId}:${Date.now()}`,
        referenceType: 'BALANCE_CARRYOVER',
        referenceId: null,
        label: 'Balance carryover',
        grossAmount: remaining,
        commissionAmount: 0,
        netAmount: remaining,
      });
      grossAmount = this.roundMoney(grossAmount + remaining);
      netAmount = this.roundMoney(netAmount + remaining);
    }

    return {
      items,
      grossAmount,
      commissionAmount,
      netAmount,
    };
  }

  private renderBuyerReceiptHtml(
    documentNumber: string,
    params: {
      issuedToName?: string | null;
      currency: string;
      grossAmount: number;
      lineItems: Array<{ label: string; amount: number }>;
      settlementCurrency?: string | null;
      settlementAmount?: number | null;
    },
  ) {
    return `
      <h1>Buyer Receipt ${documentNumber}</h1>
      <p>Issued to: ${this.escapeHtml(params.issuedToName ?? 'Customer')}</p>
      <p>Total: ${params.currency} ${params.grossAmount.toFixed(2)}</p>
      <p>Settlement: ${(params.settlementCurrency ?? params.currency)} ${(params.settlementAmount ?? params.grossAmount).toFixed(2)}</p>
      <ul>
        ${params.lineItems
          .map(
            (item) =>
              `<li>${this.escapeHtml(item.label)} - ${params.currency} ${item.amount.toFixed(2)}</li>`,
          )
          .join('')}
      </ul>
    `.trim();
  }

  private renderSettlementStatementHtml(
    documentNumber: string,
    params: {
      brandName?: string | null;
      currency: string;
      amount: number;
    },
    items: Array<{ label: string; netAmount: number }>,
  ) {
    return `
      <h1>Settlement Statement ${documentNumber}</h1>
      <p>Brand: ${this.escapeHtml(params.brandName ?? 'Brand')}</p>
      <p>Net payout: ${params.currency} ${params.amount.toFixed(2)}</p>
      <ul>
        ${items
          .map(
            (item) =>
              `<li>${this.escapeHtml(item.label)} - ${params.currency} ${item.netAmount.toFixed(2)}</li>`,
          )
          .join('')}
      </ul>
    `.trim();
  }

  private renderCommissionInvoiceHtml(
    documentNumber: string,
    params: {
      brandName?: string | null;
      currency: string;
    },
    items: Array<{ label: string; commissionAmount: number }>,
  ) {
    const total = this.roundMoney(
      items.reduce((sum, item) => sum + item.commissionAmount, 0),
    );
    return `
      <h1>Commission Invoice ${documentNumber}</h1>
      <p>Brand: ${this.escapeHtml(params.brandName ?? 'Brand')}</p>
      <p>Total commission: ${params.currency} ${total.toFixed(2)}</p>
      <ul>
        ${items
          .map(
            (item) =>
              `<li>${this.escapeHtml(item.label)} - ${params.currency} ${item.commissionAmount.toFixed(2)}</li>`,
          )
          .join('')}
      </ul>
    `.trim();
  }

  private buildDocumentNumber(prefix: string) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `${prefix}-${stamp}-${suffix}`;
  }

  private asObject(value: Prisma.JsonValue | null | undefined) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown> & { sourceItems?: unknown[] })
      : null;
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
