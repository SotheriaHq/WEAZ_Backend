import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AdminPermissionCode } from '../constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { MonitoringService } from 'src/monitoring/monitoring.service';

/**
 * Guard that checks admin permissions embedded in the JWT payload.
 * SuperAdmin always bypasses (implicit full access).
 * Must be used AFTER JwtAuthGuard and RolesGuard.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Optional()
    private readonly monitoring?: MonitoringService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<
      AdminPermissionCode[]
    >(ADMIN_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // No permissions required — allow
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      this.emitDeniedAlert(context, null, requiredPermissions, 'NO_USER');
      throw new ForbiddenException('Authentication required');
    }

    // SuperAdmin always bypasses permission checks
    if (user.role === Role.SuperAdmin) {
      return true;
    }

    // Read permissions from JWT payload (set during token generation)
    const userPermissions: string[] = user.permissions ?? [];

    const hasRequired = requiredPermissions.every((perm) =>
      userPermissions.includes(perm),
    );

    if (!hasRequired) {
      this.emitDeniedAlert(
        context,
        user,
        requiredPermissions,
        'MISSING_PERMISSION',
      );
      throw new ForbiddenException(
        'Insufficient admin permissions for this action',
      );
    }

    return true;
  }

  private emitDeniedAlert(
    context: ExecutionContext,
    user: any,
    requiredPermissions: AdminPermissionCode[],
    reason: 'NO_USER' | 'MISSING_PERMISSION',
  ): void {
    const request = context.switchToHttp().getRequest();
    this.monitoring?.emitAlert({
      category: 'SECURITY',
      severity: 'warning',
      event: 'admin_permission_denied',
      message: 'Admin permission denied',
      actorId: typeof user?.sub === 'string' ? user.sub : user?.id,
      metadata: {
        reason,
        role: user?.role ?? null,
        requiredPermissions,
        method: request?.method,
        path: request?.route?.path ?? request?.url,
      },
    });
  }
}
