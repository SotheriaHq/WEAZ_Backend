import 'reflect-metadata';
import { Role } from '@prisma/client';
import { PaymentController } from 'src/payment/payment.controller';
import { AdminDashboardController } from './dashboard/admin-dashboard.controller';
import { AdminEmailChangeController } from './email-change/admin-email-change.controller';
import { ADMIN_PERMISSIONS } from './constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from './decorators/require-permissions.decorator';
import { AdminPermissionGuard } from './guards/admin-permission.guard';

describe('Phase 0 admin permissions', () => {
  const getPermissions = (controller: any, methodName: string) =>
    Reflect.getMetadata(
      ADMIN_PERMISSIONS_KEY,
      controller.prototype[methodName],
    );

  it('requires granular permissions for dashboard, payment simulation, runtime health, and email change', () => {
    expect(getPermissions(AdminDashboardController, 'getStats')).toEqual([
      ADMIN_PERMISSIONS.DASHBOARD_READ,
    ]);
    expect(getPermissions(PaymentController, 'simulate')).toEqual([
      ADMIN_PERMISSIONS.PAYMENTS_SIMULATE,
    ]);
    expect(getPermissions(PaymentController, 'runtimeHealth')).toEqual([
      ADMIN_PERMISSIONS.PAYMENTS_RUNTIME_READ,
    ]);
    expect(getPermissions(AdminEmailChangeController, 'requestChange')).toEqual(
      [ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE],
    );
  });

  it('denies admins without permission and allows admins with permission', () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue([ADMIN_PERMISSIONS.PAYMENTS_SIMULATE]),
    };
    const monitoring = { emitAlert: jest.fn() };
    const guard = new AdminPermissionGuard(reflector as any, monitoring as any);
    const context = (user: unknown) =>
      ({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({
            user,
            method: 'POST',
            url: '/payment/simulate',
          }),
        }),
      }) as any;

    expect(() =>
      guard.canActivate(context({ role: Role.Admin, permissions: [] })),
    ).toThrow('Insufficient admin permissions');
    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'SECURITY',
        severity: 'warning',
        event: 'admin_permission_denied',
        metadata: expect.objectContaining({
          requiredPermissions: [ADMIN_PERMISSIONS.PAYMENTS_SIMULATE],
        }),
      }),
    );
    expect(
      guard.canActivate(
        context({
          role: Role.Admin,
          permissions: [ADMIN_PERMISSIONS.PAYMENTS_SIMULATE],
        }),
      ),
    ).toBe(true);
    expect(guard.canActivate(context({ role: Role.SuperAdmin }))).toBe(true);
  });
});
