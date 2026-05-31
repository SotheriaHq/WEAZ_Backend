import 'reflect-metadata';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { AdminAlertsController } from './admin-alerts.controller';

const permissionsFor = (methodName: keyof AdminAlertsController) =>
  Reflect.getMetadata(ADMIN_PERMISSIONS_KEY, AdminAlertsController.prototype[methodName]);

describe('AdminAlertsController', () => {
  it('requires read permission for list, summary, and detail endpoints', () => {
    expect(permissionsFor('list')).toEqual([ADMIN_PERMISSIONS.ALERTS_READ]);
    expect(permissionsFor('summary')).toEqual([ADMIN_PERMISSIONS.ALERTS_READ]);
    expect(permissionsFor('getById')).toEqual([ADMIN_PERMISSIONS.ALERTS_READ]);
  });

  it('requires manage permission for alert lifecycle actions', () => {
    expect(permissionsFor('acknowledge')).toEqual([
      ADMIN_PERMISSIONS.ALERTS_MANAGE,
    ]);
    expect(permissionsFor('resolve')).toEqual([ADMIN_PERMISSIONS.ALERTS_MANAGE]);
    expect(permissionsFor('ignore')).toEqual([ADMIN_PERMISSIONS.ALERTS_MANAGE]);
  });

  it('passes list filters to the service without trusting frontend-only checks', () => {
    const alertsService = {
      list: jest.fn().mockReturnValue({ items: [] }),
      summary: jest.fn(),
      getById: jest.fn(),
      acknowledge: jest.fn(),
      resolve: jest.fn(),
      ignore: jest.fn(),
    };
    const controller = new AdminAlertsController(alertsService as any);

    controller.list(
      undefined,
      '25',
      'PAYMENT',
      'CRITICAL',
      'OPEN',
      '2026-05-01',
      '2026-06-01',
      'mismatch',
      'PaymentAttempt',
      'attempt-1',
      'corr-1',
    );

    expect(alertsService.list).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 25,
      category: 'PAYMENT',
      severity: 'CRITICAL',
      status: 'OPEN',
      from: '2026-05-01',
      to: '2026-06-01',
      search: 'mismatch',
      entityType: 'PaymentAttempt',
      entityId: 'attempt-1',
      correlationId: 'corr-1',
    });
  });
});
