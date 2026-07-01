import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

// Only the `test` environment uses the @test.com system admin; every other
// environment (local, sit, uat, staging, production, ...) defaults to @wiez.com.
// An explicit SYSTEM_ADMIN_EMAIL env var always overrides these defaults.
export const DEFAULT_SYSTEM_ADMIN_EMAIL_TEST = 'adminoversee@test.com';
export const DEFAULT_SYSTEM_ADMIN_EMAIL_NON_TEST = 'adminoversee@wiez.com';
// Backwards-compatible alias for existing imports.
export const DEFAULT_SYSTEM_ADMIN_EMAIL = DEFAULT_SYSTEM_ADMIN_EMAIL_TEST;
export const SYSTEM_ADMIN_EMAIL_ENV_KEY = 'SYSTEM_ADMIN_EMAIL';
export const SYSTEM_ADMIN_PASSWORD = 'Password@123';
export const SYSTEM_ADMIN_USERNAME = 'systemadmin';

function resolveEnvironmentMarker(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.APP_ENV ?? env.DEPLOY_ENV ?? env.NODE_ENV ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Default system admin email for the current environment.
 * `test` → @test.com; every other environment → @wiez.com.
 */
export function resolveDefaultSystemAdminEmail(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveEnvironmentMarker(env) === 'test'
    ? DEFAULT_SYSTEM_ADMIN_EMAIL_TEST
    : DEFAULT_SYSTEM_ADMIN_EMAIL_NON_TEST;
}

export function resolveSystemAdminEmail(env: NodeJS.ProcessEnv = process.env) {
  const configured = String(env[SYSTEM_ADMIN_EMAIL_ENV_KEY] ?? '')
    .trim()
    .toLowerCase();
  return configured || resolveDefaultSystemAdminEmail(env);
}

export async function ensureSystemAdmin(prisma: PrismaClient) {
  const systemAdminEmail = resolveSystemAdminEmail();
  const existing = await prisma.user.findUnique({
    where: { email: systemAdminEmail },
    select: { id: true },
  });

  let userId = existing?.id;

  if (userId) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        username: SYSTEM_ADMIN_USERNAME,
        role: 'SuperAdmin',
        type: 'REGULAR',
        status: 'ACTIVE',
        isActive: 'Active',
        isEmailVerified: true,
        mustResetPassword: false,
      },
    });
  } else {
    const hashedPassword = await argon2.hash(SYSTEM_ADMIN_PASSWORD);
    const created = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: systemAdminEmail,
        username: SYSTEM_ADMIN_USERNAME,
        password: hashedPassword,
        role: 'SuperAdmin',
        type: 'REGULAR',
        status: 'ACTIVE',
        isActive: 'Active',
        isEmailVerified: true,
        mustResetPassword: false,
      },
      select: { id: true },
    });
    userId = created.id;
  }

  await prisma.userProfile.upsert({
    where: { userId },
    update: {
      firstName: 'System',
      lastName: 'Admin',
    },
    create: {
      userId,
      firstName: 'System',
      lastName: 'Admin',
    },
  });

  console.log(
    existing
      ? `System SuperAdmin updated: ${systemAdminEmail}`
      : `System SuperAdmin created: ${systemAdminEmail}`,
  );

  return { id: userId, email: systemAdminEmail, created: !existing };
}
