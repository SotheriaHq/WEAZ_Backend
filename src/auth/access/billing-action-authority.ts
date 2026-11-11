import { ConflictException, ForbiddenException } from '@nestjs/common';
import { getLiveSecurityContext } from './security-request-context';

/** New billing instructions require human authority; recurring workers use saved agreements. */
export function requireBillingAction(
  userId: string,
  brandId: string,
  action: 'checkout' | 'payment-method' | 'cancel-renewal',
) {
  const context = getLiveSecurityContext();
  if (
    !context ||
    context.operation.actor.id !== userId ||
    context.operation.policy.brandId !== brandId ||
    context.operation.policy.scope !== 'BRAND_OWNER' ||
    context.operation.policy.sensitivity !== 'CRITICAL_CHANGE' ||
    context.operation.policy.action !== 'brand.billing.change' ||
    context.operation.method !== 'POST' ||
    context.operation.route !== `/brands/:brandId/subscription/${action}`
  ) {
    throw new ForbiddenException(
      'A live approval for this subscription change is required',
    );
  }
  if (context.transaction)
    throw new ConflictException(
      'Start the subscription instruction outside another transaction',
    );
  return context.operation;
}
