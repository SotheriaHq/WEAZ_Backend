import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_SUB_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
  LEGACY_CATEGORY_SLUGS,
  FILTER_TAG_SUGGESTIONS,
} from '../src/categories/default-taxonomy';
import { seedMeasurementPoints } from './seed_measurement_points';

const SYSTEM_ADMIN_EMAIL = 'adminoversee@test.com';
const SYSTEM_ADMIN_PASSWORD = 'Password@123';

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed the database.');
}

const pool = new Pool({ connectionString: datasourceUrl });
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

  if (existing) {
    await prisma.collectionCategory.update({
      where: { id: existing.id },
      data: { name, description: description ?? null, isActive: true, order },
    });
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
    await prisma.collectionCategoryType.update({
      where: { id: existing.id },
      data: {
        name,
        description: description ?? null,
        isActive: true,
        order,
      },
    });
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

async function ensureDefaultTags() {
  // Collect all unique tags from FILTER_TAG_SUGGESTIONS
  const tagSet = new Set<string>();
  for (const suggestions of Object.values(FILTER_TAG_SUGGESTIONS)) {
    for (const tag of suggestions) {
      tagSet.add(tag);
    }
  }

  // Add some additional common platform tags
  const additionalTags = [
    'african-fashion',
    'traditional-wear',
    'modern-african',
    'handmade',
    'sustainable-fashion',
    'artisanal',
    'luxury',
    'affordable',
    'one-of-a-kind',
    'limited-edition',
    'custom-made',
    'ready-to-wear',
  ];
  for (const tag of additionalTags) {
    tagSet.add(tag);
  }

  const allTags = Array.from(tagSet);
  console.log(`Seeding ${allTags.length} platform tags...`);

  for (const tagName of allTags) {
    const normalizedName = tagName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const displayName = tagName.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    await (prisma as any).tag.upsert({
      where: { normalizedName },
      create: {
        id: randomUUID(),
        normalizedName,
        displayName,
        status: 'APPROVED',
        isBanned: false,
        usageCount: 0,
        createdById: null,
        aliasOfTagId: null,
      },
      update: {
        displayName,
        status: 'APPROVED',
        isBanned: false,
      },
    });
  }

  return allTags.length;
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

  // 2. Deactivate legacy categories
  for (const legacySlug of LEGACY_CATEGORY_SLUGS) {
    if (idsBySlug.has(legacySlug)) continue;
    const legacy = await prisma.collectionCategory.findUnique({
      where: { slug: legacySlug },
      select: { id: true },
    });
    if (legacy && legacy.isActive) {
      await prisma.collectionCategory.update({
        where: { id: legacy.id },
        data: { isActive: false },
      });
      console.log(`  Deactivated legacy category: ${legacySlug}`);
    }
  }

  // 3. Upsert sub-categories (scoped per parent)
  for (const [parentSlug, subCategories] of Object.entries(DEFAULT_SUB_CATEGORIES)) {
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

  // 4. Seed filter dimensions + values
  for (const dim of DEFAULT_FILTER_DIMENSIONS) {
    const existingDim = await prisma.filterDimension.findUnique({
      where: { slug: dim.slug },
      select: { id: true },
    });

    let dimensionId: string;

    if (existingDim) {
      await prisma.filterDimension.update({
        where: { id: existingDim.id },
        data: {
          name: dim.name,
          description: dim.description,
          order: dim.order,
          isMulti: dim.isMulti,
          appliesTo: dim.appliesTo,
          isActive: true,
        },
      });
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

      if (existingVal) {
        await prisma.filterValue.update({
          where: { id: existingVal.id },
          data: { name: val.name, order: val.order, isActive: true },
        });
      } else {
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
  }

  return idsBySlug;
}

  // 2. Deactivate legacy categories
  for (const legacySlug of LEGACY_CATEGORY_SLUGS) {
    if (idsBySlug.has(legacySlug)) continue;
    const legacy = await prisma.collectionCategory.findUnique({
      where: { slug: legacySlug },
    });
    if (legacy && legacy.isActive) {
      await prisma.collectionCategory.update({
        where: { id: legacy.id },
        data: { isActive: false },
      });
      console.log(`  Deactivated legacy category: ${legacySlug}`);
    }
  }

  // 3. Upsert sub-categories (scoped per parent)
  for (const [parentSlug, subCategories] of Object.entries(DEFAULT_SUB_CATEGORIES)) {
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

  // 4. Seed filter dimensions + values
  for (const dim of DEFAULT_FILTER_DIMENSIONS) {
    const existingDim = await prisma.filterDimension.findUnique({
      where: { slug: dim.slug },
      select: { id: true },
    });

    let dimensionId: string;

    if (existingDim) {
      await prisma.filterDimension.update({
        where: { id: existingDim.id },
        data: {
          name: dim.name,
          description: dim.description,
          order: dim.order,
          isMulti: dim.isMulti,
          appliesTo: dim.appliesTo,
          isActive: true,
        },
      });
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

      if (existingVal) {
        await prisma.filterValue.update({
          where: { id: existingVal.id },
          data: { name: val.name, order: val.order, isActive: true },
        });
      } else {
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
  }

  return idsBySlug;
}

async function ensureSystemAdmin() {
  const existing = await prisma.user.findUnique({
    where: { email: SYSTEM_ADMIN_EMAIL },
    select: { id: true },
  });

  if (existing) {
    console.log(`System admin already exists: ${SYSTEM_ADMIN_EMAIL}`);
    return;
  }

  const hashedPassword = await argon2.hash(SYSTEM_ADMIN_PASSWORD);

  await prisma.user.create({
    data: {
      id: randomUUID(),
      email: SYSTEM_ADMIN_EMAIL,
      username: 'systemadmin',
      firstName: 'System',
      lastName: 'Admin',
      password: hashedPassword,
      role: 'SuperAdmin',
      type: 'REGULAR',
      status: 'ACTIVE',
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
    },
  });

  console.log(`System SuperAdmin created: ${SYSTEM_ADMIN_EMAIL}`);
}

async function main() {
  console.log('Starting database seed...');

  await ensureSystemAdmin();

  await seedMeasurementPoints(prisma);

  await ensureDefaultTaxonomy();

  const seededTagCount = await ensureDefaultTags();

  // Log final counts
  const [totalTags, approvedTags, pendingTags, rejectedTags] = await Promise.all([
    (prisma as any).tag.count(),
    (prisma as any).tag.count({ where: { status: 'APPROVED' } }),
    (prisma as any).tag.count({ where: { status: 'PENDING' } }),
    (prisma as any).tag.count({ where: { status: 'REJECTED' } }),
  ]);

  console.log(`Seeded ${seededTagCount} platform tags`);
  console.log(`Total tags: ${totalTags} (Approved: ${approvedTags}, Pending: ${pendingTags}, Rejected: ${rejectedTags})`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
