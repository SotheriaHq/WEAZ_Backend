import { Prisma } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';

export async function reserveFullOrderRefund(tx: Prisma.TransactionClient, ledger: LedgerService, input: { id: string; customOrderId: string; brandId: string; currency: string; captureAmount: number; releasedNet: number; releasedCommission: number; unreleasedGross: number; reservationKey?: string }) {
  const cents = (amount: number) => Math.round(amount * 100);
  const values = [input.captureAmount, input.releasedNet, input.releasedCommission, input.unreleasedGross];
  if (values.some(amount => !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents(amount))) || cents(input.captureAmount) !== cents(input.releasedNet) + cents(input.releasedCommission) + cents(input.unreleasedGross)) throw new Error('CUSTOM_ORDER_REFUND_RELEASE_RECONCILIATION_REQUIRED');
  return ledger.postTransaction(tx, {
    idempotencyKey: input.reservationKey ?? `ledger:custom-order:${input.customOrderId}:queue_refund_reserved`, type: 'REVERSAL',
    referenceType: 'CustomOrderQueueRefund', referenceId: input.id, currency: input.currency, totalAmount: input.captureAmount,
    description: 'Reserve an order-scoped refund and reverse the corresponding proceeds',
    lines: [
      { code: 'SYSTEM:CUSTOM_ORDER_ESCROW', name: 'Custom Order Escrow', type: 'LIABILITY', subType: 'CUSTOM_ORDER_ESCROW', isSystemAccount: true, direction: 'DEBIT', amount: input.unreleasedGross },
      { code: `BRAND_WALLET:${input.brandId}`, name: `Brand Wallet ${input.brandId}`, type: 'LIABILITY', subType: 'BRAND_AVAILABLE', entityType: 'BRAND', entityId: input.brandId, direction: 'DEBIT', amount: input.releasedNet },
      { code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE', name: 'Platform Commission Revenue', type: 'REVENUE', subType: 'PLATFORM_COMMISSION', isSystemAccount: true, direction: 'DEBIT', amount: input.releasedCommission },
      { code: 'SYSTEM:REFUND_PAYABLE', name: 'Refund Payable', type: 'LIABILITY', subType: 'REFUND_PAYABLE', isSystemAccount: true, direction: 'CREDIT', amount: input.captureAmount },
    ],
  });
}
