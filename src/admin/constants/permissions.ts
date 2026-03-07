/**
 * Admin permission codes — the canonical policy keys.
 * Each permission grants exactly one capability.
 */
export const ADMIN_PERMISSIONS = {
  // Users
  USERS_READ: 'users.read',
  USERS_UPDATE: 'users.update',
  USERS_DEACTIVATE: 'users.deactivate',
  USERS_ROLE_ASSIGN_ADMIN: 'users.role.assign_admin',
  USERS_ROLE_ASSIGN_USER: 'users.role.assign_user',
  USERS_DATA_EXPORT: 'users.data_export',
  USERS_DATA_WIPE: 'users.data_wipe',

  // Brands
  BRANDS_READ: 'brands.read',
  BRANDS_VERIFY: 'brands.verify',
  BRANDS_SUSPEND: 'brands.suspend',
  BRANDS_STORE_READ: 'brands.store_read',
  BRANDS_STORE_VERIFY: 'brands.store_verify',
  BRANDS_STORE_OVERRIDE: 'brands.store_override',

  // Products & Collections
  PRODUCTS_READ: 'products.read',
  PRODUCTS_MODERATE: 'products.moderate',
  COLLECTIONS_READ: 'collections.read',
  COLLECTIONS_MODERATE: 'collections.moderate',

  // Featured
  FEATURED_MANAGE: 'featured.manage',

  // Taxonomy & Tags
  TAXONOMY_READ: 'taxonomy.read',
  TAXONOMY_WRITE: 'taxonomy.write',
  TAXONOMY_SUGGESTIONS_MODERATE: 'taxonomy.suggestions.moderate',
  TAGS_READ: 'tags.read',
  TAGS_MODERATE: 'tags.moderate',

  // Measurements
  MEASUREMENTS_READ: 'measurements.read',
  MEASUREMENTS_REVIEW: 'measurements.review',

  // Payouts
  PAYOUTS_READ: 'payouts.read',
  PAYOUTS_PROCESS: 'payouts.process',

  // Disputes
  DISPUTES_READ: 'disputes.read',
  DISPUTES_RESOLVE: 'disputes.resolve',

  // Moderation
  MODERATION_READ: 'moderation.read',
  MODERATION_WRITE: 'moderation.write',

  // Audit & Notifications
  AUDIT_READ: 'audit.read',
  NOTIFICATIONS_SEND: 'notifications.send',

  // System (SuperAdmin only)
  SYSTEM_SETTINGS_WRITE: 'system.settings.write',
  SYSTEM_SLA_READ: 'system.sla.read',
  SYSTEM_SLA_WRITE: 'system.sla.write',
  SYSTEM_DATA_RETENTION_WRITE: 'system.data_retention.write',
  SYSTEM_FEATURE_FLAGS_WRITE: 'system.feature_flags.write',
  PERMISSIONS_MANAGE: 'permissions.manage',
} as const;

export type AdminPermissionCode =
  (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS];

/** All permission codes as an array */
export const ALL_PERMISSION_CODES = Object.values(
  ADMIN_PERMISSIONS,
) as AdminPermissionCode[];

/** Permissions that only SuperAdmin can hold/grant */
export const SUPERADMIN_ONLY_PERMISSIONS: AdminPermissionCode[] = [
  ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN,
  ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_USER,
  ADMIN_PERMISSIONS.USERS_DATA_WIPE,
  ADMIN_PERMISSIONS.SYSTEM_SETTINGS_WRITE,
  ADMIN_PERMISSIONS.SYSTEM_SLA_WRITE,
  ADMIN_PERMISSIONS.SYSTEM_DATA_RETENTION_WRITE,
  ADMIN_PERMISSIONS.SYSTEM_FEATURE_FLAGS_WRITE,
  ADMIN_PERMISSIONS.PERMISSIONS_MANAGE,
];

/** Default permissions granted to new Admin accounts (all except SuperAdmin-only) */
export const DEFAULT_ADMIN_PERMISSIONS: AdminPermissionCode[] =
  ALL_PERMISSION_CODES.filter(
    (code) => !SUPERADMIN_ONLY_PERMISSIONS.includes(code),
  );
