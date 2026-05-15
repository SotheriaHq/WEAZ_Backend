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
  LEGACY_CATEGORY_TYPE_SLUGS,
  LEGACY_FILTER_DIMENSION_SLUGS,
  FILTER_TAG_SUGGESTIONS,
} from '../src/categories/default-taxonomy';
import { seedMeasurementPoints } from './seed_measurement_points';

const SYSTEM_ADMIN_EMAIL = 'adminoversee@test.com';
const SYSTEM_ADMIN_PASSWORD = 'Password@123';
const DEMO_BRAND_OWNER_EMAIL = 'brand.owner@test.com';
const DEMO_BUYER_EMAIL = 'buyer@test.com';
const DEMO_USER_PASSWORD = 'Password@123';
const DEMO_BRAND_OWNER_ID = '11111111-1111-4111-8111-111111111111';
const DEMO_BUYER_ID = '22222222-2222-4222-8222-222222222222';
const DEMO_BRAND_ID = '33333333-3333-4333-8333-333333333333';
const DEMO_DESIGN_ID = '44444444-4444-4444-8444-444444444444';
const DEMO_PRODUCT_ID = '55555555-5555-4555-8555-555555555555';
const DEMO_STORE_COLLECTION_ID = '66666666-6666-4666-8666-666666666666';
const DEMO_FABRIC_BASIS_ID = '77777777-7777-4777-8777-777777777777';
const DEMO_CUSTOM_ORDER_CONFIG_ID = '88888888-8888-4888-8888-888888888888';
const DEMO_CUSTOM_ORDER_CONFIG_VERSION_ID = '99999999-9999-4999-8999-999999999999';
const DEMO_CUSTOM_FABRIC_RULE_ID = '98989898-9898-4989-8989-989898989898';
const DEMO_STORE_COLLECTION_PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEMO_DESIGN_MEDIA_IDS = [
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
];
const DEMO_FILE_UPLOAD_IDS = [
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
];

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
    'ankara-fashion',
    'aso-ebi',
    'owambe',
    'office-style',
    'wedding-guest',
    'modest-fashion',
    'statement-piece',
    'bridal',
    'adire',
    'aso-oke',
    'kente',
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
      select: { id: true, isActive: true },
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

  // 4. Deactivate legacy category types without touching valid seeded types.
  const activeTypeKeys = new Set<string>();
  for (const [parentSlug, subCategories] of Object.entries(DEFAULT_SUB_CATEGORIES)) {
    const categoryId = idsBySlug.get(parentSlug);
    if (!categoryId) continue;
    for (const sub of subCategories) {
      activeTypeKeys.add(`${categoryId}:${sub.slug}`);
    }
  }
  const legacyTypes = await prisma.collectionCategoryType.findMany({
    where: {
      isActive: true,
      OR: [
        { slug: { in: LEGACY_CATEGORY_TYPE_SLUGS } },
        { category: { slug: { in: LEGACY_CATEGORY_SLUGS } } },
      ],
    },
    select: {
      id: true,
      slug: true,
      categoryId: true,
      category: { select: { slug: true } },
    },
  });
  for (const type of legacyTypes) {
    if (activeTypeKeys.has(`${type.categoryId}:${type.slug}`)) continue;
    const isLegacyType = LEGACY_CATEGORY_TYPE_SLUGS.includes(type.slug);
    const isUnderLegacyCategory = LEGACY_CATEGORY_SLUGS.includes(
      type.category.slug,
    );
    if (!isLegacyType && !isUnderLegacyCategory) continue;
    await prisma.collectionCategoryType.update({
      where: { id: type.id },
      data: { isActive: false },
    });
    console.log(`  Deactivated legacy category type: ${type.slug}`);
  }

  // 5. Seed filter dimensions + values
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

    const activeValueSlugs = dim.values.map((value) => value.slug);
    const deactivatedValues = await prisma.filterValue.updateMany({
      where: {
        dimensionId,
        isActive: true,
        slug: { notIn: activeValueSlugs },
      },
      data: { isActive: false },
    });
    if (deactivatedValues.count > 0) {
      console.log(
        `  Deactivated ${deactivatedValues.count} obsolete values in filter dimension: ${dim.slug}`,
      );
    }
  }

  const activeDimensionSlugs = DEFAULT_FILTER_DIMENSIONS.map((dim) => dim.slug);
  const legacyFilterSlugs = LEGACY_FILTER_DIMENSION_SLUGS.filter(
    (slug) => !activeDimensionSlugs.includes(slug),
  );
  if (legacyFilterSlugs.length > 0) {
    const deactivatedDimensions = await prisma.filterDimension.updateMany({
      where: { slug: { in: legacyFilterSlugs }, isActive: true },
      data: { isActive: false },
    });
    if (deactivatedDimensions.count > 0) {
      console.log(
        `  Deactivated ${deactivatedDimensions.count} legacy filter dimensions: ${legacyFilterSlugs.join(', ')}`,
      );
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
      password: hashedPassword,
      role: 'SuperAdmin',
      type: 'REGULAR',
      status: 'ACTIVE',
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
      userProfile: {
        create: {
          firstName: 'System',
          lastName: 'Admin',
        },
      },
    },
  });

  console.log(`System SuperAdmin created: ${SYSTEM_ADMIN_EMAIL}`);
}

async function upsertUserWithProfile(args: {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  type: 'BRAND' | 'REGULAR';
  role?: 'User' | 'Admin' | 'SuperAdmin';
}) {
  const hashedPassword = await argon2.hash(DEMO_USER_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email: args.email },
    update: {
      username: args.username,
      type: args.type,
      role: args.role ?? 'User',
      status: 'ACTIVE',
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
    },
    create: {
      id: args.id,
      email: args.email,
      username: args.username,
      password: hashedPassword,
      type: args.type,
      role: args.role ?? 'User',
      status: 'ACTIVE',
      isActive: 'Active',
      isEmailVerified: true,
      mustResetPassword: false,
    },
    select: { id: true },
  });

  await prisma.userProfile.upsert({
    where: { userId: user.id },
    update: {
      firstName: args.firstName,
      lastName: args.lastName,
    },
    create: {
      userId: user.id,
      firstName: args.firstName,
      lastName: args.lastName,
    },
  });

  return user.id;
}

async function findSubCategoryId(categoryId: string, slug: string) {
  const categoryType = await prisma.collectionCategoryType.findFirst({
    where: { categoryId, slug, isActive: true },
    select: { id: true },
  });
  return categoryType?.id ?? null;
}

type SeedEntityType = 'DESIGN' | 'PRODUCT' | 'STORE_COLLECTION';
type SeedFilterSelection = { dimensionSlug: string; valueSlug: string };

async function findFilterValueIdsForSeed(
  entityType: SeedEntityType,
  selections: SeedFilterSelection[],
) {
  const ids: string[] = [];
  for (const selection of selections) {
    const filterValue = await prisma.filterValue.findFirst({
      where: {
        slug: selection.valueSlug,
        isActive: true,
        dimension: {
          slug: selection.dimensionSlug,
          isActive: true,
        },
      },
      select: {
        id: true,
        dimension: { select: { appliesTo: true } },
      },
    });
    const appliesTo = Array.isArray(filterValue?.dimension?.appliesTo)
      ? filterValue.dimension.appliesTo
      : [];
    if (filterValue?.id && appliesTo.includes(entityType)) {
      ids.push(filterValue.id);
    } else {
      console.warn(
        `Missing seeded filter value ${selection.dimensionSlug}/${selection.valueSlug} for ${entityType}`,
      );
    }
  }
  return Array.from(new Set(ids));
}

async function setSeedEntityFilters(
  entityType: SeedEntityType,
  entityId: string,
  selections: SeedFilterSelection[],
) {
  const filterValueIds = await findFilterValueIdsForSeed(entityType, selections);
  await prisma.entityFilter.deleteMany({ where: { entityType, entityId } });
  if (filterValueIds.length === 0) return;
  await prisma.entityFilter.createMany({
    data: filterValueIds.map((filterValueId) => ({
      id: randomUUID(),
      filterValueId,
      entityType,
      entityId,
      ...(entityType === 'PRODUCT' ? { productId: entityId } : {}),
      ...(entityType === 'DESIGN' ? { designId: entityId } : {}),
    })),
  });
}

async function upsertDemoFileUpload(userId: string, index: number) {
  const s3Key = `seed/design/domain-sample-${index + 1}.jpg`;
  const s3Url = `https://threadly.local/uploads/${s3Key}`;
  const existing = await prisma.fileUpload.findUnique({
    where: { s3Key },
    select: { id: true },
  });

  const data = {
    userId,
    originalName: `domain-sample-${index + 1}.jpg`,
    fileName: `domain-sample-${index + 1}.jpg`,
    s3Key,
    s3Url,
    fileType: 'POST_IMAGE' as const,
    mimeType: 'image/jpeg',
    size: 100_000 + index,
    processingStatus: 'READY' as const,
    width: 1200,
    height: 1600,
    isPublic: true,
  };

  if (existing) {
    await prisma.fileUpload.update({
      where: { id: existing.id },
      data,
    });
    return { id: existing.id, s3Url };
  }

  const created = await prisma.fileUpload.create({
    data: {
      id: DEMO_FILE_UPLOAD_IDS[index],
      ...data,
    },
    select: { id: true },
  });
  return { id: created.id, s3Url };
}

async function ensureDemoCatalogSeed(idsBySlug: Map<string, string>) {
  const brandOwnerId = await upsertUserWithProfile({
    id: DEMO_BRAND_OWNER_ID,
    email: DEMO_BRAND_OWNER_EMAIL,
    username: 'threadly_brand_owner',
    firstName: 'Demo',
    lastName: 'Designer',
    type: 'BRAND',
  });
  const buyerId = await upsertUserWithProfile({
    id: DEMO_BUYER_ID,
    email: DEMO_BUYER_EMAIL,
    username: 'threadly_buyer',
    firstName: 'Demo',
    lastName: 'Buyer',
    type: 'REGULAR',
  });

  const brand = await prisma.brand.upsert({
    where: { ownerId: brandOwnerId },
    update: {
      name: 'Threadly Atelier',
      description: 'Demo African fashion brand for local reset validation.',
      tags: ['demo', 'ankara', 'custom-order'],
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      isStoreOpen: true,
      currency: 'NGN',
    },
    create: {
      id: DEMO_BRAND_ID,
      ownerId: brandOwnerId,
      name: 'Threadly Atelier',
      description: 'Demo African fashion brand for local reset validation.',
      tags: ['demo', 'ankara', 'custom-order'],
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      isStoreOpen: true,
      currency: 'NGN',
    },
    select: { id: true },
  });

  const categoryId = idsBySlug.get('dresses-gowns') ?? null;
  const categoryTypeId = categoryId
    ? await findSubCategoryId(categoryId, 'maxi-dress')
    : null;
  const mediaFiles = await Promise.all(
    DEMO_FILE_UPLOAD_IDS.map((_, index) => upsertDemoFileUpload(brandOwnerId, index)),
  );

  await prisma.design.upsert({
    where: { id: DEMO_DESIGN_ID },
    update: {
      ownerId: brandOwnerId,
      brandId: brand.id,
      title: 'Ankara Evening Concept',
      description: 'Four-view sample design for fresh database validation.',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      type: 'FEMALE',
      categoryId,
      categoryTypeId,
      tags: ['ankara-fashion', 'eveningwear', 'custom-order', 'statement-piece'],
      customOrderEnabled: true,
      sizingMode: 'CUSTOM',
      customMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      fitPreference: 'REGULAR',
      targetAgeGroup: 'ADULT',
    },
    create: {
      id: DEMO_DESIGN_ID,
      ownerId: brandOwnerId,
      brandId: brand.id,
      title: 'Ankara Evening Concept',
      description: 'Four-view sample design for fresh database validation.',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      type: 'FEMALE',
      categoryId,
      categoryTypeId,
      tags: ['ankara-fashion', 'eveningwear', 'custom-order', 'statement-piece'],
      customOrderEnabled: true,
      sizingMode: 'CUSTOM',
      customMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      fitPreference: 'REGULAR',
      targetAgeGroup: 'ADULT',
    },
  });

  for (const [index, file] of mediaFiles.entries()) {
    await prisma.designMedia.upsert({
      where: { id: DEMO_DESIGN_MEDIA_IDS[index] },
      update: {
        designId: DEMO_DESIGN_ID,
        fileUploadId: file.id,
        orderIndex: index,
        mediaType: 'POST_IMAGE',
      },
      create: {
        id: DEMO_DESIGN_MEDIA_IDS[index],
        designId: DEMO_DESIGN_ID,
        fileUploadId: file.id,
        orderIndex: index,
        mediaType: 'POST_IMAGE',
      },
    });
  }

  await prisma.design.update({
    where: { id: DEMO_DESIGN_ID },
    data: { coverMediaId: DEMO_DESIGN_MEDIA_IDS[0] },
  });

  await setSeedEntityFilters('DESIGN', DEMO_DESIGN_ID, [
    { dimensionSlug: 'style', valueSlug: 'statement-bold' },
    { dimensionSlug: 'heritage', valueSlug: 'african-cultural' },
    { dimensionSlug: 'heritage', valueSlug: 'ankara' },
    { dimensionSlug: 'occasion', valueSlug: 'owambe-party' },
    { dimensionSlug: 'fabric', valueSlug: 'ankara' },
    { dimensionSlug: 'color-family', valueSlug: 'multicolor' },
    { dimensionSlug: 'fit', valueSlug: 'regular' },
  ]);

  const fabricBasis = await prisma.customFabricRuleBasis.upsert({
    where: { id: DEMO_FABRIC_BASIS_ID },
    update: {
      label: 'Demo gown measurement basis',
      measurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      brandId: brand.id,
      status: 'BRAND_ONLY',
    },
    create: {
      id: DEMO_FABRIC_BASIS_ID,
      label: 'Demo gown measurement basis',
      measurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      brandId: brand.id,
      status: 'BRAND_ONLY',
    },
    select: { id: true },
  });

  const customOrderConfiguration = await prisma.customOrderConfiguration.upsert({
    where: {
      sourceType_sourceId: {
        sourceType: 'DESIGN',
        sourceId: DEMO_DESIGN_ID,
      },
    },
    update: {
      brandId: brand.id,
      title: 'Ankara Evening Custom Order',
      buyerInstructionText: 'Share event date, preferred sleeve style, and exact measurements.',
      requiredMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      fabricRuleBasisId: fabricBasis.id,
      baseProductionCharge: 15000,
      fabricCostPerYard: 3500,
      productionLeadDays: 14,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'NATIONWIDE',
      revisionPolicy: 'One fitting adjustment is included.',
      returnPolicy: 'Custom orders are final after buyer approval.',
      defectPolicy: 'Defects are repaired or remade after review.',
      fabricSourcingMode: 'BRAND_SOURCED',
      isActive: true,
    },
    create: {
      id: DEMO_CUSTOM_ORDER_CONFIG_ID,
      brandId: brand.id,
      sourceType: 'DESIGN',
      sourceId: DEMO_DESIGN_ID,
      title: 'Ankara Evening Custom Order',
      buyerInstructionText: 'Share event date, preferred sleeve style, and exact measurements.',
      requiredMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_WAIST', 'WOMEN_HIP'],
      requiredFreeformPointIds: [],
      fabricRuleBasisId: fabricBasis.id,
      baseProductionCharge: 15000,
      fabricCostPerYard: 3500,
      productionLeadDays: 14,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'NATIONWIDE',
      revisionPolicy: 'One fitting adjustment is included.',
      returnPolicy: 'Custom orders are final after buyer approval.',
      defectPolicy: 'Defects are repaired or remade after review.',
      fabricSourcingMode: 'BRAND_SOURCED',
      isActive: true,
    },
    select: { id: true },
  });

  await prisma.customFabricRule.upsert({
    where: { id: DEMO_CUSTOM_FABRIC_RULE_ID },
    update: {
      configurationId: customOrderConfiguration.id,
      priority: 1,
      conditionsJson: {},
      outputYards: 4.5,
      isFallback: true,
    },
    create: {
      id: DEMO_CUSTOM_FABRIC_RULE_ID,
      configurationId: customOrderConfiguration.id,
      priority: 1,
      conditionsJson: {},
      outputYards: 4.5,
      isFallback: true,
    },
  });

  await prisma.customOrderConfigurationVersion.upsert({
    where: {
      configurationId_version: {
        configurationId: customOrderConfiguration.id,
        version: 1,
      },
    },
    update: {
      snapshotJson: {
        sourceType: 'DESIGN',
        sourceId: DEMO_DESIGN_ID,
        title: 'Ankara Evening Custom Order',
      },
    },
    create: {
      id: DEMO_CUSTOM_ORDER_CONFIG_VERSION_ID,
      configurationId: customOrderConfiguration.id,
      version: 1,
      snapshotJson: {
        sourceType: 'DESIGN',
        sourceId: DEMO_DESIGN_ID,
        title: 'Ankara Evening Custom Order',
      },
      createdById: brandOwnerId,
    },
  });

  const product = await prisma.product.upsert({
    where: { id: DEMO_PRODUCT_ID },
    update: {
      brandId: brand.id,
      categoryId,
      categoryTypeId,
      name: 'Ready-to-Wear Ankara Gown',
      description: 'Sellable ready-to-wear sample product.',
      price: 65000,
      currency: 'NGN',
      images: mediaFiles.map((file) => file.s3Url),
      thumbnail: mediaFiles[0]?.s3Url,
      totalStock: 8,
      sizes: ['S', 'M', 'L'],
      sizeStock: { S: 2, M: 4, L: 2 },
      tags: ['ankara-fashion', 'ready-to-wear', 'wedding-guest'],
      gender: 'FEMALE',
      isActive: true,
    },
    create: {
      id: DEMO_PRODUCT_ID,
      brandId: brand.id,
      categoryId,
      categoryTypeId,
      name: 'Ready-to-Wear Ankara Gown',
      slug: 'ready-to-wear-ankara-gown',
      description: 'Sellable ready-to-wear sample product.',
      price: 65000,
      currency: 'NGN',
      images: mediaFiles.map((file) => file.s3Url),
      thumbnail: mediaFiles[0]?.s3Url,
      totalStock: 8,
      sizes: ['S', 'M', 'L'],
      sizeStock: { S: 2, M: 4, L: 2 },
      tags: ['ankara-fashion', 'ready-to-wear', 'wedding-guest'],
      gender: 'FEMALE',
      isActive: true,
    },
    select: { id: true },
  });

  await setSeedEntityFilters('PRODUCT', product.id, [
    { dimensionSlug: 'style', valueSlug: 'bridal-wedding' },
    { dimensionSlug: 'style', valueSlug: 'statement-bold' },
    { dimensionSlug: 'heritage', valueSlug: 'ankara' },
    { dimensionSlug: 'occasion', valueSlug: 'wedding' },
    { dimensionSlug: 'fabric', valueSlug: 'ankara' },
    { dimensionSlug: 'color-family', valueSlug: 'multicolor' },
    { dimensionSlug: 'fit', valueSlug: 'regular' },
  ]);

  await prisma.storeCollection.upsert({
    where: { id: DEMO_STORE_COLLECTION_ID },
    update: {
      ownerId: brandOwnerId,
      title: 'Evening Capsule',
      description: 'Grouping sample that contains a sellable product.',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      type: 'FEMALE',
      categoryId,
      categoryTypeId,
      isAvailableInStore: true,
      tags: ['capsule', 'eveningwear', 'owambe'],
    },
    create: {
      id: DEMO_STORE_COLLECTION_ID,
      ownerId: brandOwnerId,
      title: 'Evening Capsule',
      description: 'Grouping sample that contains a sellable product.',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      type: 'FEMALE',
      categoryId,
      categoryTypeId,
      isAvailableInStore: true,
      tags: ['capsule', 'eveningwear', 'owambe'],
    },
  });

  await setSeedEntityFilters('STORE_COLLECTION', DEMO_STORE_COLLECTION_ID, [
    { dimensionSlug: 'style', valueSlug: 'evening-luxury' },
    { dimensionSlug: 'heritage', valueSlug: 'african-cultural' },
    { dimensionSlug: 'occasion', valueSlug: 'owambe-party' },
    { dimensionSlug: 'fabric', valueSlug: 'ankara' },
    { dimensionSlug: 'color-family', valueSlug: 'multicolor' },
    { dimensionSlug: 'fit', valueSlug: 'regular' },
  ]);

  await prisma.storeCollectionProduct.upsert({
    where: {
      collectionId_productId: {
        collectionId: DEMO_STORE_COLLECTION_ID,
        productId: product.id,
      },
    },
    update: { orderIndex: 0, isPrimary: true },
    create: {
      id: DEMO_STORE_COLLECTION_PRODUCT_ID,
      collectionId: DEMO_STORE_COLLECTION_ID,
      productId: product.id,
      orderIndex: 0,
      isPrimary: true,
    },
  });

  await prisma.savedItem.upsert({
    where: {
      userId_targetType_targetId: {
        userId: buyerId,
        targetType: 'DESIGN',
        targetId: DEMO_DESIGN_ID,
      },
    },
    update: {},
    create: {
      id: randomUUID(),
      userId: buyerId,
      targetType: 'DESIGN',
      targetId: DEMO_DESIGN_ID,
    },
  });

  await prisma.savedItem.upsert({
    where: {
      userId_targetType_targetId: {
        userId: buyerId,
        targetType: 'PRODUCT',
        targetId: product.id,
      },
    },
    update: {},
    create: {
      id: randomUUID(),
      userId: buyerId,
      targetType: 'PRODUCT',
      targetId: product.id,
    },
  });

  console.log('Seeded reset-ready demo Design/Product/StoreCollection data.');
}

async function main() {
  console.log('Starting database seed...');

  await ensureSystemAdmin();

  await seedMeasurementPoints(prisma);

  const idsBySlug = await ensureDefaultTaxonomy();

  const seededTagCount = await ensureDefaultTags();

  await ensureDemoCatalogSeed(idsBySlug);

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
