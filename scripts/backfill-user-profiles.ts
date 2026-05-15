import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  createScriptPrismaClient,
  type ScriptPrismaClient,
} from './helpers/create-script-prisma';

const BATCH_SIZE = 500;
let scriptPrisma: ScriptPrismaClient | null = null;

type LegacyUserProfileFields = {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function deriveProfileName(user: Pick<LegacyUserProfileFields, 'username' | 'email'>) {
  const fallback = user.username || user.email.split('@')[0] || 'User';
  const parts = fallback
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    firstName: parts[0] ?? 'User',
    lastName: parts.slice(1).join(' ') || '',
  };
}

async function userProfileTableExists(
  prisma: ScriptPrismaClient['prisma'],
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
    Prisma.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'UserProfile'
    `,
  );
  return rows.length > 0;
}

async function main() {
  scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;
  const write = hasFlag('--write');

  if (!(await userProfileTableExists(prisma))) {
    const message =
      '[user-profile-backfill] missing UserProfile table. Apply the UserProfile migration before running this backfill.';

    if (write) {
      throw new Error(message);
    }

    console.warn(message);
    console.log('[user-profile-backfill] mode=dry-run missing=0');
    return;
  }

  const totalMissing = await prisma.user.count({
    where: { userProfile: null },
  });

  console.log(
    `[user-profile-backfill] mode=${write ? 'write' : 'dry-run'} missing=${totalMissing}`,
  );

  if (!write || totalMissing === 0) {
    return;
  }

  let created = 0;

  while (true) {
    const users = (await prisma.user.findMany({
      where: { userProfile: null },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    })) as LegacyUserProfileFields[];

    if (users.length === 0) {
      break;
    }

    const result = await prisma.userProfile.createMany({
      data: users.map((user) => {
        const profileName = deriveProfileName(user);
        return {
          id: uuidv4(),
          userId: user.id,
          firstName: profileName.firstName,
          lastName: profileName.lastName,
          profileVisibility: 'UNLOCKED',
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        };
      }),
      skipDuplicates: true,
    });

    created += result.count;
    console.log(
      `[user-profile-backfill] processed=${users.length} created=${created}`,
    );

    if (users.length < BATCH_SIZE) {
      break;
    }
  }

  const remaining = await prisma.user.count({
    where: { userProfile: null },
  });
  console.log(`[user-profile-backfill] complete created=${created} remaining=${remaining}`);
}

main()
  .catch((error) => {
    console.error('[user-profile-backfill] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await scriptPrisma?.disconnect();
  });
