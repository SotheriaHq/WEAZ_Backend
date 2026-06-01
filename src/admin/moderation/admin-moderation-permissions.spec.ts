import 'reflect-metadata';

import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { AdminModerationController } from './admin-moderation.controller';

const getRequiredPermissions = (methodName: keyof AdminModerationController) =>
  Reflect.getMetadata(
    ADMIN_PERMISSIONS_KEY,
    AdminModerationController.prototype[methodName],
  );

describe('AdminModerationController permissions', () => {
  it('requires read permission for moderation queues and measurement reads', () => {
    expect(getRequiredPermissions('getQueue')).toEqual([
      ADMIN_PERMISSIONS.MODERATION_READ,
    ]);
    expect(getRequiredPermissions('getMeasurementPoints')).toEqual([
      ADMIN_PERMISSIONS.MEASUREMENTS_READ,
    ]);
    expect(getRequiredPermissions('getMeasurementPointLifecycle')).toEqual([
      ADMIN_PERMISSIONS.MEASUREMENTS_READ,
    ]);
  });

  it('requires write/review permission for moderation actions', () => {
    expect(getRequiredPermissions('reviewItem')).toEqual([
      ADMIN_PERMISSIONS.MODERATION_WRITE,
    ]);
    expect(getRequiredPermissions('quarantineThreads')).toEqual([
      ADMIN_PERMISSIONS.MODERATION_WRITE,
    ]);
    expect(getRequiredPermissions('bulkRemoveThreads')).toEqual([
      ADMIN_PERMISSIONS.MODERATION_WRITE,
    ]);
    expect(getRequiredPermissions('updateMeasurementPointLifecycle')).toEqual([
      ADMIN_PERMISSIONS.MEASUREMENTS_REVIEW,
    ]);
  });
});
