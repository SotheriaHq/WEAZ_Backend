import {
  CustomOrderCheckoutStatus,
  CustomOrderStatus,
  PaymentStatus,
} from '@prisma/client';
import { BagValidationService } from './bag-validation.service';

describe('BagValidationService duplicate classification', () => {
  const service = new BagValidationService();

  it('classifies IN_BAG for an unlinked checkout session', () => {
    const result = service.classifyDuplicateState({
      checkoutSessions: [
        {
          id: 'session_1',
          checkoutIntentId: 'intent_1',
          customOrderId: null,
          status: CustomOrderCheckoutStatus.SUBMITTED,
        },
      ],
      completedPolicy: 'ALLOW_REPEAT',
    });

    expect(result.classifications).toEqual(['IN_BAG']);
    expect(result.inBag).toBe(true);
    expect(result.reason).toBe('CUSTOM_ORDER_DUPLICATE_IN_BAG');
  });

  it('classifies SUBMITTED_UNPAID for an unpaid active custom order', () => {
    const result = service.classifyDuplicateState({
      customOrders: [
        {
          id: 'order_1',
          status: CustomOrderStatus.PENDING_PAYMENT,
          paymentStatus: PaymentStatus.PENDING,
        },
      ],
      completedPolicy: 'ALLOW_REPEAT',
    });

    expect(result.classifications).toEqual(['SUBMITTED_UNPAID']);
    expect(result.submittedUnpaid).toBe(true);
    expect(result.reason).toBe('CUSTOM_ORDER_SUBMITTED_UNPAID_DUPLICATE');
  });

  it('classifies PAID_ACTIVE for a paid non-terminal custom order', () => {
    const result = service.classifyDuplicateState({
      customOrders: [
        {
          id: 'order_1',
          status: CustomOrderStatus.IN_PRODUCTION,
          paymentStatus: PaymentStatus.PAID,
        },
      ],
      completedPolicy: 'ALLOW_REPEAT',
    });

    expect(result.classifications).toEqual(['PAID_ACTIVE']);
    expect(result.paidActive).toBe(true);
    expect(result.reason).toBe('CUSTOM_ORDER_PAID_ACTIVE_DUPLICATE');
  });

  it('classifies COMPLETED_ALLOWED when repeat completed custom orders are allowed', () => {
    const result = service.classifyDuplicateState({
      customOrders: [
        {
          id: 'order_1',
          status: CustomOrderStatus.COMPLETED,
          paymentStatus: PaymentStatus.PAID,
        },
      ],
      completedPolicy: 'ALLOW_REPEAT',
    });

    expect(result.classifications).toEqual(['COMPLETED_ALLOWED']);
    expect(result.completedPolicy).toBe('ALLOW_REPEAT');
    expect(result.reason).toBeNull();
  });

  it('classifies COMPLETED_BLOCKED only when policy blocks repeat completed custom orders', () => {
    const result = service.classifyDuplicateState({
      customOrders: [
        {
          id: 'order_1',
          status: CustomOrderStatus.COMPLETED,
          paymentStatus: PaymentStatus.PAID,
        },
      ],
      completedPolicy: 'BLOCK_REPEAT',
    });

    expect(result.classifications).toEqual(['COMPLETED_BLOCKED']);
    expect(result.completedPolicy).toBe('BLOCK_REPEAT');
    expect(result.reason).toBe('CUSTOM_ORDER_COMPLETED_DUPLICATE');
  });
});
