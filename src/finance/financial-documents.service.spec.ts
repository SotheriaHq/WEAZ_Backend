import { Prisma } from '@prisma/client';
import { FinancialDocumentsService } from './financial-documents.service';

describe('FinancialDocumentsService', () => {
  let service: FinancialDocumentsService;
  let prisma: any;
  let tx: any;

  beforeEach(() => {
    prisma = {
      financialDocument: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };

    tx = {
      financialDocument: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      ledgerTransaction: {
        findMany: jest.fn(),
      },
    };

    service = new FinancialDocumentsService(prisma);
  });

  it('returns the existing buyer receipt instead of creating a duplicate', async () => {
    tx.financialDocument.findFirst.mockResolvedValue({ id: 'doc-existing' });

    const result = await service.issueBuyerReceipt(tx, {
      paymentAttemptId: 'attempt-1',
      orderIds: ['order-1'],
      currency: 'NGN',
      grossAmount: 15000,
      lineItems: [{ label: 'Order order-1', amount: 15000 }],
    });

    expect(result).toEqual({ id: 'doc-existing' });
    expect(tx.financialDocument.create).not.toHaveBeenCalled();
  });

  it('creates settlement and commission documents from released ledger coverage', async () => {
    tx.financialDocument.findFirst.mockResolvedValue(null);
    tx.financialDocument.findMany.mockResolvedValue([]);
    tx.ledgerTransaction.findMany.mockResolvedValue([
      {
        id: 'ledger-1',
        referenceType: 'Order',
        referenceId: 'order-1',
        entries: [
          {
            direction: 'CREDIT',
            amount: new Prisma.Decimal('90.00'),
            account: {
              subType: 'BRAND_AVAILABLE',
              entityId: 'brand-1',
            },
          },
          {
            direction: 'CREDIT',
            amount: new Prisma.Decimal('10.00'),
            account: {
              subType: 'PLATFORM_COMMISSION',
              entityId: null,
            },
          },
        ],
      },
    ]);
    tx.financialDocument.create
      .mockResolvedValueOnce({ id: 'statement-1' })
      .mockResolvedValueOnce({ id: 'invoice-1' });

    await service.issuePayoutSettlementStatement(tx, {
      payoutId: 'payout-1',
      brandId: 'brand-1',
      brandName: 'Brand One',
      currency: 'NGN',
      amount: 90,
    });
    await service.issueCommissionInvoice(tx, {
      payoutId: 'payout-1',
      brandId: 'brand-1',
      brandName: 'Brand One',
      currency: 'NGN',
      amount: 90,
    });

    expect(tx.financialDocument.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'BRAND_SETTLEMENT_STATEMENT',
          payoutId: 'payout-1',
          grossAmount: new Prisma.Decimal('90.00'),
          commissionAmount: new Prisma.Decimal('10.00'),
          netAmount: new Prisma.Decimal('90.00'),
        }),
      }),
    );
    expect(tx.financialDocument.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'PLATFORM_COMMISSION_INVOICE',
          payoutId: 'payout-1',
          grossAmount: new Prisma.Decimal('100.00'),
          commissionAmount: new Prisma.Decimal('10.00'),
          netAmount: new Prisma.Decimal('90.00'),
        }),
      }),
    );
  });
});
