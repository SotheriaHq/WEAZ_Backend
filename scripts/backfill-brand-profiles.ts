import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();
const BATCH_SIZE = 250;

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

function shouldSetTags(
  current: string[] | null | undefined,
  legacy: string[] | null | undefined,
  overwrite: boolean,
): boolean {
  const legacyTags = Array.isArray(legacy) ? legacy.filter(Boolean) : [];
  if (legacyTags.length === 0) return false;
  return overwrite || !Array.isArray(current) || current.length === 0;
}

function detectConflict(
  current: string | null | undefined,
  legacy: string | null | undefined,
): boolean {
  const currentValue = filled(current);
  const legacyValue = filled(legacy);
  return Boolean(currentValue && legacyValue && currentValue !== legacyValue);
}

function detectTagConflict(
  current: string[] | null | undefined,
  legacy: string[] | null | undefined,
): boolean {
  const currentTags = Array.isArray(current) ? current.filter(Boolean) : [];
  const legacyTags = Array.isArray(legacy) ? legacy.filter(Boolean) : [];
  return (
    currentTags.length > 0 &&
    legacyTags.length > 0 &&
    currentTags.join('|') !== legacyTags.join('|')
  );
}

async function main() {
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
        firstName: true,
        lastName: true,
        brandFullName: true,
        brandDescription: true,
        brandCountry: true,
        brandState: true,
        brandCity: true,
        brandTags: true,
        brandBusinessType: true,
        socialInstagram: true,
        socialFacebook: true,
        socialTwitter: true,
        socialWebsite: true,
        cacNumber: true,
        tin: true,
        ceoNin: true,
        ceoFirstName: true,
        ceoLastName: true,
        companyLocation: true,
        industriNumber: true,
        brand: true,
      },
    });

    if (users.length === 0) break;

    for (const user of users) {
      counts.usersScanned += 1;
      const fallbackName =
        filled(user.brandFullName) ||
        [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
        user.username ||
        'Brand';

      try {
        if (!user.brand) {
          counts.brandsCreated += 1;
          if (write) {
            await prisma.brand.create({
              data: {
                id: uuidv4(),
                ownerId: user.id,
                name: fallbackName,
                description: user.brandDescription,
                tags: user.brandTags ?? [],
                country: user.brandCountry,
                state: user.brandState,
                city: user.brandCity,
                businessType: user.brandBusinessType,
                socialInstagram: user.socialInstagram,
                socialFacebook: user.socialFacebook,
                socialTwitter: user.socialTwitter,
                socialWebsite: user.socialWebsite,
                cacNumber: user.cacNumber,
                tin: user.tin,
                ceoNin: user.ceoNin,
                ceoFirstName: user.ceoFirstName,
                ceoLastName: user.ceoLastName,
                companyLocation: user.companyLocation,
                industriNumber: user.industriNumber,
                storeNameLastChangedAt: new Date(),
                currency: 'NGN',
              },
            });
          }
          continue;
        }

        const updates: Record<string, unknown> = {};
        const stringPairs = [
          ['name', user.brandFullName],
          ['description', user.brandDescription],
          ['country', user.brandCountry],
          ['state', user.brandState],
          ['city', user.brandCity],
          ['businessType', user.brandBusinessType],
          ['socialInstagram', user.socialInstagram],
          ['socialFacebook', user.socialFacebook],
          ['socialTwitter', user.socialTwitter],
          ['socialWebsite', user.socialWebsite],
          ['cacNumber', user.cacNumber],
          ['tin', user.tin],
          ['ceoNin', user.ceoNin],
          ['ceoFirstName', user.ceoFirstName],
          ['ceoLastName', user.ceoLastName],
          ['companyLocation', user.companyLocation],
          ['industriNumber', user.industriNumber],
        ] as const;

        for (const [brandField, legacyValue] of stringPairs) {
          const currentValue = user.brand[brandField];
          if (detectConflict(currentValue as string | null, legacyValue)) {
            counts.conflictsDetected += 1;
          }
          if (shouldSet(currentValue as string | null, legacyValue, overwrite)) {
            updates[brandField] = filled(legacyValue);
          }
        }

        if (detectTagConflict(user.brand.tags, user.brandTags)) {
          counts.conflictsDetected += 1;
        }
        if (shouldSetTags(user.brand.tags, user.brandTags, overwrite)) {
          updates.tags = user.brandTags;
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
    await prisma.$disconnect();
  });
