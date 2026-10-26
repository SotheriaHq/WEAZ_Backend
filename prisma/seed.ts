import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { withUtcDatabaseUrl } from '../src/prisma/database-connection';
import { randomUUID } from 'crypto';
import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_SUB_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
} from '../src/categories/default-taxonomy';
import { seedMeasurementPoints } from './seed_measurement_points';
import { seedSizeCharts } from './seed_size_charts';
import { ensureSystemAdmin } from './seed-system-admin';
import { seedPlatformTags } from './seed_tags';
import { SystemConfigService } from '../src/admin/system-config/system-config.service';
import { SettlementPolicyService } from '../src/finance/settlement-policy.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed the database.');
}

const pool = new Pool({ connectionString: withUtcDatabaseUrl(datasourceUrl) });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function upsertCategory(
  slug: string,
  name: string,
  description?: string | null,
  order = 0,
) {
  const existing = await prisma.collectionCategory.findUnique({
    where: { slug },
    select: { id: true },
  });

  // Reference defaults are inserted once; admin edits to existing rows are kept.
  if (existing) {
    return existing.id;
  }

  const created = await prisma.collectionCategory.create({
    data: {
      id: randomUUID(),
      slug,
      name,
      description: description ?? null,
      isActive: true,
      order,
    },
    select: { id: true },
  });
  return created.id;
}

async function upsertCategoryType(
  categoryId: string,
  slug: string,
  name: string,
  description?: string | null,
  order = 0,
) {
  const existing = await prisma.collectionCategoryType.findFirst({
    where: { categoryId, slug },
    select: { id: true },
  });

  if (existing) {
    return existing.id;
  }

  const created = await prisma.collectionCategoryType.create({
    data: {
      id: randomUUID(),
      categoryId,
      slug,
      name,
      description: description ?? null,
      isActive: true,
      order,
    },
    select: { id: true },
  });
  return created.id;
}

async function ensureDefaultTaxonomy() {
  const idsBySlug = new Map<string, string>();

  // 1. Upsert main categories
  for (const category of DEFAULT_COLLECTION_CATEGORIES) {
    const id = await upsertCategory(
      category.slug,
      category.name,
      category.description,
      category.order,
    );
    idsBySlug.set(category.slug, id);
  }

  // 3. Upsert sub-categories (scoped per parent)
  for (const [parentSlug, subCategories] of Object.entries(
    DEFAULT_SUB_CATEGORIES,
  )) {
    const categoryId = idsBySlug.get(parentSlug);
    if (!categoryId) continue;

    for (const sub of subCategories) {
      await upsertCategoryType(
        categoryId,
        sub.slug,
        sub.name,
        sub.description ?? null,
        sub.order,
      );
    }
  }

  // 5. Seed filter dimensions + values
  for (const dim of DEFAULT_FILTER_DIMENSIONS) {
    const existingDim = await prisma.filterDimension.findUnique({
      where: { slug: dim.slug },
      select: { id: true },
    });

    let dimensionId: string;

    if (existingDim) {
      dimensionId = existingDim.id;
    } else {
      const created = await prisma.filterDimension.create({
        data: {
          id: randomUUID(),
          slug: dim.slug,
          name: dim.name,
          description: dim.description,
          order: dim.order,
          isMulti: dim.isMulti,
          appliesTo: dim.appliesTo,
          isActive: true,
        },
        select: { id: true },
      });
      dimensionId = created.id;
    }

    for (const val of dim.values) {
      const existingVal = await prisma.filterValue.findFirst({
        where: { dimensionId, slug: val.slug },
        select: { id: true },
      });

      if (!existingVal) {
        await prisma.filterValue.create({
          data: {
            id: randomUUID(),
            dimensionId,
            slug: val.slug,
            name: val.name,
            order: val.order,
            isActive: true,
          },
        });
      }
    }

    // Values an admin added are not defaults and are never deactivated here.
  }

  return idsBySlug;
}

async function main() {
  console.log('Starting database seed...');

  await ensureSystemAdmin(prisma);

  await seedMeasurementPoints(prisma);
  await seedSizeCharts(prisma);

  await ensureDefaultTaxonomy();

  const seededTagCount = await seedPlatformTags(prisma);

  const systemConfig = new SystemConfigService(prisma as unknown as PrismaService);
  await systemConfig.seedDefaults();
  await new SettlementPolicyService(prisma as unknown as PrismaService, systemConfig).seedDefaults();

  // Log final counts
  const [totalTags, approvedTags, pendingTags, rejectedTags] =
    await Promise.all([
      (prisma as any).tag.count(),
      (prisma as any).tag.count({ where: { status: 'APPROVED' } }),
      (prisma as any).tag.count({ where: { status: 'PENDING' } }),
      (prisma as any).tag.count({ where: { status: 'REJECTED' } }),
    ]);

  console.log(`Seeded ${seededTagCount} platform tags`);
  console.log(
    `Total tags: ${totalTags} (Approved: ${approvedTags}, Pending: ${pendingTags}, Rejected: ${rejectedTags})`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (e) => {
    console.error('Reference database seed failed.');
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
