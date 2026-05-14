import { BrandMemberRole, BrandMemberStatus, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  createScriptPrismaClient,
  type ScriptPrismaClient,
} from './helpers/create-script-prisma';

const BATCH_SIZE = 250;
let scriptPrisma: ScriptPrismaClient | null = null;

export type BrandMemberBackfillCounts = {
  brandsScanned: number;
  ownersMissingMembership: number;
  ownerMembershipsCreated: number;
  alreadyValid: number;
  conflictsDetected: number;
  errors: number;
};

export type BrandMemberBackfillOptions = {
  write?: boolean;
  fixConflicts?: boolean;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function hasBrandMemberTable(
  prisma: ScriptPrismaClient['prisma'],
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
    Prisma.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'BrandMember'
    `,
  );
  return rows.length > 0;
}

export async function runBrandMemberBackfill(
  prisma: ScriptPrismaClient['prisma'],
  options: BrandMemberBackfillOptions = {},
): Promise<BrandMemberBackfillCounts> {
  const counts: BrandMemberBackfillCounts = {
    brandsScanned: 0,
    ownersMissingMembership: 0,
    ownerMembershipsCreated: 0,
    alreadyValid: 0,
    conflictsDetected: 0,
    errors: 0,
  };

  let cursor: string | undefined;
  while (true) {
    const brands = await prisma.brand.findMany({
      orderBy: { createdAt: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: BATCH_SIZE,
      select: {
        id: true,
        ownerId: true,
        createdAt: true,
      },
    });

    if (brands.length === 0) break;

    for (const brand of brands) {
      counts.brandsScanned += 1;

      try {
        const existing = await prisma.brandMember.findUnique({
          where: {
            brandId_userId: {
              brandId: brand.id,
              userId: brand.ownerId,
            },
          },
          select: {
            id: true,
            role: true,
            status: true,
          },
        });

        if (!existing) {
          counts.ownersMissingMembership += 1;
          if (options.write) {
            await prisma.brandMember.create({
              data: {
                id: uuidv4(),
                brandId: brand.id,
                userId: brand.ownerId,
                role: BrandMemberRole.OWNER,
                status: BrandMemberStatus.ACTIVE,
                joinedAt: brand.createdAt ?? new Date(),
              },
            });
            counts.ownerMembershipsCreated += 1;
          }
          continue;
        }

        if (
          existing.role === BrandMemberRole.OWNER &&
          existing.status === BrandMemberStatus.ACTIVE
        ) {
          counts.alreadyValid += 1;
          continue;
        }

        counts.conflictsDetected += 1;

        if (options.write && options.fixConflicts) {
          await prisma.brandMember.update({
            where: { id: existing.id },
            data: {
              role: BrandMemberRole.OWNER,
              status: BrandMemberStatus.ACTIVE,
              joinedAt: brand.createdAt ?? new Date(),
            },
          });
        }
      } catch (error) {
        counts.errors += 1;
        console.error(
          `[brand-member-backfill] brand=${brand.id} owner=${brand.ownerId} failed: ${String(
            (error as Error)?.message ?? error,
          )}`,
        );
      }
    }

    cursor = brands[brands.length - 1]?.id;
    if (brands.length < BATCH_SIZE) break;
  }

  return counts;
}

function printCounts(counts: BrandMemberBackfillCounts): void {
  console.log(`[brand-member-backfill] brands scanned: ${counts.brandsScanned}`);
  console.log(
    `[brand-member-backfill] owners missing membership: ${counts.ownersMissingMembership}`,
  );
  console.log(
    `[brand-member-backfill] owner memberships created: ${counts.ownerMembershipsCreated}`,
  );
  console.log(`[brand-member-backfill] already valid: ${counts.alreadyValid}`);
  console.log(
    `[brand-member-backfill] conflicts detected: ${counts.conflictsDetected}`,
  );
  console.log(`[brand-member-backfill] errors: ${counts.errors}`);
}

async function main() {
  scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;
  const write = hasFlag('--write');
  const fixConflicts = hasFlag('--fix-conflicts');

  console.log(
    `[brand-member-backfill] mode=${write ? 'write' : 'dry-run'} fixConflicts=${fixConflicts}`,
  );

  const tableExists = await hasBrandMemberTable(prisma);
  if (!tableExists) {
    const message =
      '[brand-member-backfill] missing BrandMember table. Apply the Phase 4 BrandMember migration before running this backfill.';

    if (write) {
      throw new Error(message);
    }

    console.warn(message);
    printCounts({
      brandsScanned: 0,
      ownersMissingMembership: 0,
      ownerMembershipsCreated: 0,
      alreadyValid: 0,
      conflictsDetected: 0,
      errors: 0,
    });
    return;
  }

  if (fixConflicts && !write) {
    console.warn(
      '[brand-member-backfill] --fix-conflicts has no effect in dry-run mode.',
    );
  }

  const counts = await runBrandMemberBackfill(prisma, { write, fixConflicts });
  printCounts(counts);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[brand-member-backfill] failed', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await scriptPrisma?.disconnect();
    });
}
