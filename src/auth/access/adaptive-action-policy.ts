import type { AccessSensitivity } from './access-policy.engine';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';

const criticalAdministratorPermissions = new Set<string>([
  ADMIN_PERMISSIONS.PAYOUTS_PROCESS, ADMIN_PERMISSIONS.DISPUTES_REFUND,
  ADMIN_PERMISSIONS.PERMISSIONS_MANAGE, ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN,
  ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_USER, ADMIN_PERMISSIONS.USERS_MFA_RECOVER,
  ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE,
]);

export type AdaptiveActionPolicy = {
  sensitivity: AccessSensitivity;
  action: string;
  scope: 'SELF' | 'ADMIN' | 'BRAND_OWNER' | 'BRAND_PAYOUT_READ';
  brandId?: string;
};
/** Server route templates, never user-supplied paths/roles or policy headers. */
export function classifyAdaptiveAction(
  method: string,
  route: string,
  params: Record<string, string> = {},
  state: { enrolledMfa: boolean; actorRole?: string; adminPermissions?: readonly string[];
    requiredRoles?: readonly string[] } = { enrolledMfa: false },
): AdaptiveActionPolicy {
  const read = method === 'GET' || method === 'HEAD';
  const path = `/${route}`.replace(/\/+/g, '/').replace(/\/$/, '');
  const administratorOnly = Boolean(state.requiredRoles?.length &&
    state.requiredRoles.every(role => ['Admin', 'SuperAdmin'].includes(role)));
  const selfServiceMfa = path.startsWith('/auth/security/mfa') && !state.adminPermissions?.length;
  if ((administratorOnly && !selfServiceMfa) || state.adminPermissions?.length || path === '/admin' || path.startsWith('/admin/') ||
    path === '/dev-tools' || path.startsWith('/dev-tools/')) {
    const critical = !read && (state.adminPermissions?.some(code => criticalAdministratorPermissions.has(code)) ||
      /^\/admin\/(?:security|finance|payouts|ledger|users|team|roles|permissions|email-change|break-glass|subscriptions|system-config|feature-flags|jobs)(?:\/|$)/.test(path));
    return { sensitivity: critical ? 'CRITICAL_CHANGE' : 'SENSITIVE_READ',
      action: critical ? 'admin.critical-change' : 'admin.access', scope: 'ADMIN' };
  }
  // The authenticated server principal, never a body/header role, selects
  // the admin boundary on these otherwise shared owner/admin lookups.
  if (['Admin', 'SuperAdmin'].includes(state.actorRole ?? '') &&
    ((read && /^\/uploads\/(?:signed-url\/:fileId|signed-url-by-key|:fileId\/variants)$/.test(path)) ||
      (method === 'POST' && path === '/uploads/signed-urls-by-source')))
    return { sensitivity: 'SENSITIVE_READ', action: 'admin.media.read', scope: 'ADMIN' };
  if (path.startsWith('/auth/security/mfa')) {
    if (
      method === 'POST' &&
      /^\/auth\/security\/mfa\/factors\/:id\/revoke$/.test(path)
    )
      return {
        sensitivity: 'CRITICAL_CHANGE',
        action: 'authentication.factor.remove',
        scope: 'SELF',
      };
    if (
      method === 'POST' &&
      path === '/auth/security/mfa/recovery-codes/regenerate'
    )
      return {
        sensitivity: 'CRITICAL_CHANGE',
        action: 'authentication.recovery-codes.replace',
        scope: 'SELF',
      };
    if (
      method === 'POST' &&
      state.enrolledMfa &&
      /^\/auth\/security\/mfa\/(?:totp|passkeys)\/begin$/.test(path)
    ) {
      return {
        sensitivity: 'CRITICAL_CHANGE',
        action: 'authentication.factor.add',
        scope: 'SELF',
      };
    }
    return {
      sensitivity: 'ACCOUNT',
      action: 'authentication.recovery',
      scope: 'SELF',
    };
  }
  if (/^\/brands\/:brandId\/payouts(?:\/|$)/.test(path))
    return {
      sensitivity: read ? 'SENSITIVE_READ' : 'CRITICAL_CHANGE',
      action: read ? 'brand.finance.read' : 'brand.payout.change',
      scope: read ? 'BRAND_PAYOUT_READ' : 'BRAND_OWNER',
      brandId: params.brandId,
    };
  if (/^\/store\/(?:wallet|payouts|payment-account)(?:\/|$)/.test(path))
    return {
      sensitivity: read ? 'SENSITIVE_READ' : 'CRITICAL_CHANGE',
      action: read ? 'brand.finance.read' : 'brand.payout-account.change',
      scope: read ? 'BRAND_PAYOUT_READ' : 'BRAND_OWNER',
    };
  if (
    /^\/brands\/:brandId\/subscription(?:\/|$)/.test(path) &&
    !/\/(?:verify|notice|notice\/dismiss)$/.test(path)
  )
    return {
      sensitivity:
        !read && /\/(?:checkout|payment-method|cancel-renewal)$/.test(path)
          ? 'CRITICAL_CHANGE'
          : 'SENSITIVE_READ',
      action: read ? 'brand.billing.read' : 'brand.billing.change',
      scope: 'BRAND_OWNER',
      brandId: params.brandId,
    };
  if (
    !read &&
    /^\/auth\/(?:admin\/change-password|change-password|change-email|change-phone|google\/link|account\/delete)(?:\/|$)/.test(
      path,
    )
  ) {
    return {
      sensitivity: 'CRITICAL_CHANGE',
      action: 'account.security.change',
      scope: 'SELF',
    };
  }
  if (!read && /^\/brands\/:brandId\/(?:staff|members)(?:\/|$)/.test(path))
    return {
      sensitivity: 'CRITICAL_CHANGE',
      action: 'brand.permissions.change',
      scope: 'BRAND_OWNER',
      brandId: params.brandId,
    };
  return { sensitivity: 'ACCOUNT', action: 'account.access', scope: 'SELF' };
}
