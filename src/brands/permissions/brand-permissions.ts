import { BrandMemberRole } from '@prisma/client';

export const BRAND_PERMISSION_CODES = [
  'brand.profile.read',
  'brand.profile.update',
  'brand.staff.read',
  'brand.staff.manage',
  'catalog.read',
  'catalog.write',
  'catalog.delete',
  'orders.read',
  'orders.update',
  'messages.read',
  'messages.reply',
  'payouts.read',
  'settings.update',
  'verification.submit',
] as const;

export type BrandPermissionCode = (typeof BRAND_PERMISSION_CODES)[number];

export const BRAND_PERMISSIONS = {
  BRAND_PROFILE_READ: 'brand.profile.read',
  BRAND_PROFILE_UPDATE: 'brand.profile.update',
  BRAND_STAFF_READ: 'brand.staff.read',
  BRAND_STAFF_MANAGE: 'brand.staff.manage',
  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',
  CATALOG_DELETE: 'catalog.delete',
  ORDERS_READ: 'orders.read',
  ORDERS_UPDATE: 'orders.update',
  MESSAGES_READ: 'messages.read',
  MESSAGES_REPLY: 'messages.reply',
  PAYOUTS_READ: 'payouts.read',
  SETTINGS_UPDATE: 'settings.update',
  VERIFICATION_SUBMIT: 'verification.submit',
} as const satisfies Record<string, BrandPermissionCode>;

export const ROLE_DEFAULT_PERMISSIONS = {
  [BrandMemberRole.OWNER]: BRAND_PERMISSION_CODES,
  [BrandMemberRole.MANAGER]: [
    BRAND_PERMISSIONS.BRAND_PROFILE_READ,
    BRAND_PERMISSIONS.BRAND_PROFILE_UPDATE,
    BRAND_PERMISSIONS.CATALOG_READ,
    BRAND_PERMISSIONS.CATALOG_WRITE,
    BRAND_PERMISSIONS.CATALOG_DELETE,
    BRAND_PERMISSIONS.ORDERS_READ,
    BRAND_PERMISSIONS.ORDERS_UPDATE,
    BRAND_PERMISSIONS.MESSAGES_READ,
    BRAND_PERMISSIONS.MESSAGES_REPLY,
    BRAND_PERMISSIONS.SETTINGS_UPDATE,
  ],
  [BrandMemberRole.CATALOG_MANAGER]: [
    BRAND_PERMISSIONS.CATALOG_READ,
    BRAND_PERMISSIONS.CATALOG_WRITE,
    BRAND_PERMISSIONS.CATALOG_DELETE,
  ],
  [BrandMemberRole.ORDER_MANAGER]: [
    BRAND_PERMISSIONS.ORDERS_READ,
    BRAND_PERMISSIONS.ORDERS_UPDATE,
  ],
  [BrandMemberRole.SUPPORT_AGENT]: [
    BRAND_PERMISSIONS.MESSAGES_READ,
    BRAND_PERMISSIONS.MESSAGES_REPLY,
    BRAND_PERMISSIONS.ORDERS_READ,
  ],
  [BrandMemberRole.VIEWER]: [
    BRAND_PERMISSIONS.BRAND_PROFILE_READ,
    BRAND_PERMISSIONS.CATALOG_READ,
    BRAND_PERMISSIONS.ORDERS_READ,
  ],
} as const satisfies Record<BrandMemberRole, readonly BrandPermissionCode[]>;

export const KNOWN_BRAND_PERMISSION_CODES = new Set<BrandPermissionCode>(
  BRAND_PERMISSION_CODES,
);
