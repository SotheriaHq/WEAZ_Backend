import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

export const DEFAULT_SYSTEM_ADMIN_EMAIL = 'adminoversee@test.com';
export const SYSTEM_ADMIN_EMAIL_ENV_KEY = 'SYSTEM_ADMIN_EMAIL';
export const SYSTEM_ADMIN_PASSWORD = 'Password@123';
export const SYSTEM_ADMIN_USERNAME = 'systemadmin';

export function resolveSystemAdminEmail(env: NodeJS.ProcessEnv = process.env) {
  return (
    String(env[SYSTEM_ADMIN_EMAIL_ENV_KEY] ?? DEFAULT_SYSTEM_ADMIN_EMAIL)
      .trim()
      .toLowerCase() || DEFAULT_SYSTEM_ADMIN_EMAIL
  );
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
