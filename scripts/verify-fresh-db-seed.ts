import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to verify the fresh database seed.');
}

const pool = new Pool({ connectionString: datasourceUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

type CheckResult = {
  name: string;
  passed: boolean;
  value?: unknown;
  note?: string;
};

const checks: CheckResult[] = [];

function record(name: string, passed: boolean, value?: unknown, note?: string) {
  checks.push({ name, passed, value, note });
}

async function main() {
  const [
    users,
    profiles,
    brands,
    categories,
    subcategories,
    filterDimensions,
    measurementPoints,
    products,
    storeCollections,
    savedDesigns,
    savedProducts,
    designFilters,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userProfile.count(),
    prisma.brand.count(),
    prisma.collectionCategory.count(),
    prisma.collectionCategoryType.count(),
    prisma.filterDimension.count(),
    prisma.measurementPoint.count(),
    prisma.product.count(),
    prisma.storeCollection.count(),
    prisma.savedItem.count({ where: { targetType: 'DESIGN' } }),
    prisma.savedItem.count({ where: { targetType: 'PRODUCT' } }),
    prisma.entityFilter.count({ where: { entityType: 'DESIGN' } }),
  ]);

  const design = await prisma.design.findFirst({
    where: { status: 'PUBLISHED' },
    include: {
      medias: { orderBy: { orderIndex: 'asc' } },
      brand: true,
      category: true,
      categoryType: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const customOrderConfiguration = design
    ? await prisma.customOrderConfiguration.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: 'DESIGN',
            sourceId: design.id,
          },
        },
      })
    : null;

  const storeCollectionWithProduct = await prisma.storeCollection.findFirst({
    where: { products: { some: {} } },
    include: { products: true },
  });

  const savedDesignTarget = design
    ? await prisma.savedItem.findFirst({
        where: { targetType: 'DESIGN', targetId: design.id },
      })
    : null;

  const savedProductTarget = await prisma.product.findFirst({
    where: {
      id: {
        in: (
          await prisma.savedItem.findMany({
            where: { targetType: 'PRODUCT' },
            select: { targetId: true },
          })
        ).map((item) => item.targetId),
      },
    },
  });

  record('users exist', users > 0, users);
  record('user profiles exist', profiles > 0, profiles);
  record('brand/store exists', brands > 0, brands);
  record('categories exist', categories > 0, categories);
  record('subcategories exist', subcategories > 0, subcategories);
  record('filter dimensions exist', filterDimensions > 0, filterDimensions);
  record('measurement points exist', measurementPoints > 0, measurementPoints);
  record('explicit published Design exists', Boolean(design), design?.id);
  record('Design has exactly four media', design?.medias.length === 4, design?.medias.length);
  record('Design has category and subcategory', Boolean(design?.categoryId && design?.categoryTypeId), {
    categoryId: design?.categoryId,
    categoryTypeId: design?.categoryTypeId,
  });
  record('Design has custom-order flag enabled', design?.customOrderEnabled === true, design?.customOrderEnabled);
  record('Design custom-order configuration exists', Boolean(customOrderConfiguration), customOrderConfiguration?.id);
  record('Product exists', products > 0, products);
  record('StoreCollection exists', storeCollections > 0, storeCollections);
  record(
    'StoreCollection has product membership',
    Boolean(storeCollectionWithProduct && storeCollectionWithProduct.products.length > 0),
    storeCollectionWithProduct?.products.length ?? 0,
  );
  record('Saved DESIGN example exists', savedDesigns > 0 && Boolean(savedDesignTarget), savedDesigns);
  record('Saved PRODUCT example exists', savedProducts > 0 && Boolean(savedProductTarget), savedProducts);
  record(
    'EntityFilter DESIGN rows present if seeded',
    true,
    designFilters,
    designFilters > 0 ? undefined : 'No DESIGN EntityFilter rows were seeded; this is informational.',
  );

  const failed = checks.filter((check) => !check.passed);
  const summary = {
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    checkedAt: new Date().toISOString(),
    checks,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
