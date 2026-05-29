import 'reflect-metadata';
import { AdminFeaturedController } from './featured/admin-featured.controller';
import { AdminUsersController } from './users/admin-users.controller';
import { ADMIN_PERMISSIONS } from './constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from './decorators/require-permissions.decorator';

const getPermissions = (controller: any, methodName: string) =>
  Reflect.getMetadata(ADMIN_PERMISSIONS_KEY, controller.prototype[methodName]);

describe('Admin governance permission metadata', () => {
  it('requires exact permissions on sensitive SuperAdmin user actions', () => {
    expect(getPermissions(AdminUsersController, 'createAdmin')).toEqual([
      ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN,
    ]);
    expect(getPermissions(AdminUsersController, 'updateRole')).toEqual([
      ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN,
      ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_USER,
    ]);
    expect(getPermissions(AdminUsersController, 'forcePasswordReset')).toEqual([
      ADMIN_PERMISSIONS.USERS_UPDATE,
    ]);
    expect(getPermissions(AdminUsersController, 'reissueTempPassword')).toEqual(
      [ADMIN_PERMISSIONS.USERS_UPDATE],
    );
    expect(getPermissions(AdminUsersController, 'dataExport')).toEqual([
      ADMIN_PERMISSIONS.USERS_DATA_EXPORT,
    ]);
    expect(getPermissions(AdminUsersController, 'dataWipe')).toEqual([
      ADMIN_PERMISSIONS.USERS_DATA_WIPE,
    ]);
    expect(
      getPermissions(AdminUsersController, 'permanentlyDeleteAdminUser'),
    ).toEqual([ADMIN_PERMISSIONS.USERS_DATA_WIPE]);
  });

  it('requires featured governance permission on featured history and block actions', () => {
    expect(getPermissions(AdminFeaturedController, 'history')).toEqual([
      ADMIN_PERMISSIONS.FEATURED_MANAGE,
    ]);
    expect(
      getPermissions(AdminFeaturedController, 'toggleBlockProduct'),
    ).toEqual([ADMIN_PERMISSIONS.FEATURED_MANAGE]);
    expect(
      getPermissions(AdminFeaturedController, 'toggleBlockCollection'),
    ).toEqual([ADMIN_PERMISSIONS.FEATURED_MANAGE]);
    expect(getPermissions(AdminFeaturedController, 'toggleBlockBrand')).toEqual(
      [ADMIN_PERMISSIONS.FEATURED_MANAGE],
    );
  });
});
