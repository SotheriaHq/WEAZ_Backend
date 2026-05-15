import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  createScriptPrismaClient,
  type ScriptPrismaClient,
} from './helpers/create-script-prisma';

const BATCH_SIZE = 250;
let scriptPrisma: ScriptPrismaClient | null = null;
const REQUIRED_BRAND_COLUMNS = [
  'country',
  'state',
  'city',
  'businessType',
  'companyLocation',
  'socialFacebook',
  'cacNumber',
  'tin',
  'ceoNin',
  'ceoFirstName',
  'ceoLastName',
  'industriNumber',
] as const;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function filled(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldSet(
  current: string | null | undefined,
  legacy: string | null | undefined,
  overwrite: boolean,
): boolean {
  const legacyValue = filled(legacy);
  if (!legacyValue) return false;
  return overwrite || !filled(current);
}

function buildBrandName(user: {
  username: string;
  userProfile?: { firstName: string; lastName: string } | null;
}): string {
  const profileName = [
    user.userProfile?.firstName,
    user.userProfile?.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  return filled(profileName) ?? user.username ?? 'Brand';
}

async function findMissingBrandColumns(
  prisma: ScriptPrismaClient['prisma'],
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>(
    Prisma.sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Brand'
        AND column_name IN (${Prisma.join(REQUIRED_BRAND_COLUMNS)})
    `,
  );
  const presentColumns = new Set(rows.map((row) => row.column_name));
  return REQUIRED_BRAND_COLUMNS.filter((column) => !presentColumns.has(column));
}

async function main() {
  scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;
  const write = hasFlag('--write');
  const overwrite = hasFlag('--overwrite');
  const counts = {
    usersScanned: 0,
    brandsCreated: 0,
    brandsUpdated: 0,
    skippedAlreadyCanonical: 0,
    conflictsDetected: 0,
    errors: 0,
  };

  console.log(
    `[brand-profile-backfill] mode=${write ? 'write' : 'dry-run'} overwrite=${overwrite}`,
  );

  const missingBrandColumns = await findMissingBrandColumns(prisma);
  if (missingBrandColumns.length > 0) {
    const message =
      `[brand-profile-backfill] missing Brand columns: ${missingBrandColumns.join(', ')}. ` +
      'Apply the Phase 3 Brand profile migration before running this backfill.';

    if (write) {
      throw new Error(message);
    }

    console.warn(message);
    console.log('[brand-profile-backfill] users scanned: 0');
    console.log('[brand-profile-backfill] brands created: 0');
    console.log('[brand-profile-backfill] brands updated: 0');
    console.log('[brand-profile-backfill] skipped already canonical: 0');
    console.log('[brand-profile-backfill] conflicts detected: 0');
    console.log('[brand-profile-backfill] errors: 0');
    return;
  }

  let cursor: string | undefined;
  while (true) {
    const users = await prisma.user.findMany({
      where: { type: 'BRAND' },
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH_SIZE,
      select: {
        id: true,
        username: true,
        userProfile: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        brand: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (users.length === 0) break;

    for (const user of users) {
      counts.usersScanned += 1;
      const fallbackName = buildBrandName(user);

      try {
        if (!user.brand) {
          counts.brandsCreated += 1;
          if (write) {
            await prisma.brand.create({
              data: {
                id: uuidv4(),
                ownerId: user.id,
                name: fallbackName,
                storeNameLastChangedAt: new Date(),
                currency: 'NGN',
              },
            });
          }
          continue;
        }

        const updates: Record<string, unknown> = {};
        if (shouldSet(user.brand.name, fallbackName, overwrite)) {
          updates.name = fallbackName;
        }

        if (Object.keys(updates).length === 0) {
          counts.skippedAlreadyCanonical += 1;
          continue;
        }

        counts.brandsUpdated += 1;
        if (write) {
          await prisma.brand.update({
            where: { id: user.brand.id },
            data: updates,
          });
        }
      } catch (error) {
        counts.errors += 1;
        console.error(
          `[brand-profile-backfill] user=${user.id} failed: ${String(
            (error as Error)?.message ?? error,
          )}`,
        );
      }
    }

    cursor = users[users.length - 1]?.id;
    if (users.length < BATCH_SIZE) break;
  }

  console.log(`[brand-profile-backfill] users scanned: ${counts.usersScanned}`);
  console.log(`[brand-profile-backfill] brands created: ${counts.brandsCreated}`);
  console.log(`[brand-profile-backfill] brands updated: ${counts.brandsUpdated}`);
  console.log(
    `[brand-profile-backfill] skipped already canonical: ${counts.skippedAlreadyCanonical}`,
  );
  console.log(
    `[brand-profile-backfill] conflicts detected: ${counts.conflictsDetected}`,
  );
  console.log(`[brand-profile-backfill] errors: ${counts.errors}`);
}

main()
  .catch((error) => {
    console.error('[brand-profile-backfill] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await scriptPrisma?.disconnect();
  });
