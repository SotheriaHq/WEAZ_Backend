import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

export const SYSTEM_ADMIN_EMAIL = 'adminoversee@test.com';
export const SYSTEM_ADMIN_PASSWORD = 'Password@123';
export const SYSTEM_ADMIN_USERNAME = 'systemadmin';

export async function ensureSystemAdmin(prisma: PrismaClient) {
  const existing = await prisma.user.findUnique({
    where: { email: SYSTEM_ADMIN_EMAIL },
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
        email: SYSTEM_ADMIN_EMAIL,
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
      ? `System SuperAdmin updated: ${SYSTEM_ADMIN_EMAIL}`
      : `System SuperAdmin created: ${SYSTEM_ADMIN_EMAIL}`,
  );

  return { id: userId, email: SYSTEM_ADMIN_EMAIL, created: !existing };
}
