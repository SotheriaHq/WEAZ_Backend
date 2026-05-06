import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();
const BATCH_SIZE = 500;

type LegacyUserProfileFields = {
  id: string;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  address: string | null;
  profileImage: string | null;
  profileImageId: string | null;
  bannerImage: string | null;
  bannerImageId: string | null;
  profileVisibility: 'UNLOCKED' | 'LOCKED';
  createdAt: Date;
  updatedAt: Date;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const write = hasFlag('--write');
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
        firstName: true,
        lastName: true,
        phoneNumber: true,
        address: true,
        profileImage: true,
        profileImageId: true,
        bannerImage: true,
        bannerImageId: true,
        profileVisibility: true,
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
      data: users.map((user) => ({
        id: uuidv4(),
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: user.phoneNumber,
        address: user.address,
        profileImage: user.profileImage,
        profileImageId: user.profileImageId,
        bannerImage: user.bannerImage,
        bannerImageId: user.bannerImageId,
        profileVisibility: user.profileVisibility,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
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
    await prisma.$disconnect();
  });
