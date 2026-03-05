import { SetMetadata } from '@nestjs/common';
import { AdminPermissionCode } from '../constants/permissions';

export const ADMIN_PERMISSIONS_KEY = 'admin_permissions';

/**
 * Decorator to require specific admin permissions on an endpoint.
 * Used with AdminPermissionGuard.
 * SuperAdmin always bypasses permission checks.
 */
export const RequirePermissions = (...permissions: AdminPermissionCode[]) =>
  SetMetadata(ADMIN_PERMISSIONS_KEY, permissions);
