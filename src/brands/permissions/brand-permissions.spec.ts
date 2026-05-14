import { BadRequestException } from '@nestjs/common';
import { BrandMemberRole } from '@prisma/client';
import {
  BRAND_PERMISSION_CODES,
  KNOWN_BRAND_PERMISSION_CODES,
  ROLE_DEFAULT_PERMISSIONS,
} from './brand-permissions';
import { BrandPermissionService } from './brand-permission.service';

describe('brand permissions constants', () => {
  it('role defaults contain only known permission codes', () => {
    for (const role of Object.values(BrandMemberRole)) {
      for (const permission of ROLE_DEFAULT_PERMISSIONS[role]) {
        expect(KNOWN_BRAND_PERMISSION_CODES.has(permission)).toBe(true);
      }
    }
  });

  it('OWNER defaults to every brand permission', () => {
    expect(ROLE_DEFAULT_PERMISSIONS[BrandMemberRole.OWNER]).toEqual(
      BRAND_PERMISSION_CODES,
    );
  });

  it('unknown permission codes are rejected', () => {
    const service = new BrandPermissionService({} as any);

    expect(() => service.validatePermissionCode('unknown.permission')).toThrow(
      BadRequestException,
    );
  });
});
