import { CustomOrderStatus, MessageThreadStatus, OrderStatus } from '@prisma/client';
import { MessagingPolicyService } from './messaging-policy.service';

describe('custom-order conversation lifecycle policy', () => {
  const policy = new MessagingPolicyService();
  it.each(Object.values(CustomOrderStatus))('allows the existing participants to discuss a %s custom order', status => {
    expect(policy.resolveThreadStatusForCustomOrder(status)).toBe(MessageThreadStatus.OPEN);
  });
  it.each([MessageThreadStatus.BLOCKED, MessageThreadStatus.ARCHIVED, MessageThreadStatus.READ_ONLY])('preserves explicit %s thread restrictions', status => {
    expect(() => policy.assertCanSend(status)).toThrow('Thread is read-only');
  });
  it('preserves standard-order completion policy', () => {
    expect(policy.resolveThreadStatusForOrder(OrderStatus.DELIVERED)).toBe(MessageThreadStatus.READ_ONLY);
  });
});
