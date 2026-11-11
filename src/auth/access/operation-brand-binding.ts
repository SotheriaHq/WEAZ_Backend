import { ConflictException } from '@nestjs/common';
import { getLiveSecurityContext } from './security-request-context';

/** A domain resolver may not silently change the tenant approved at admission. */
export function assertOperationBrand(brandId: string | null | undefined): void {
  const operation = getLiveSecurityContext()?.operation;
  if (!operation || !operation.policy.scope.startsWith('BRAND')) return;
  if (!brandId || operation.policy.brandId !== brandId) {
    throw new ConflictException({ code: 'SECURITY_BRAND_CONTEXT_CHANGED',
      message: 'The brand for this action changed. Verify the intended brand and try again.' });
  }
}
