import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';

const DEMO_BRAND_EMAIL = 'brand@example.com';
const DEMO_BRAND_PASSWORD = 'password123';

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed the database.');
}

const pool = new Pool({ connectionString: datasourceUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function upsertCategory(slug: string, name: string, description?: string | null, order = 0) {
  const existing = await prisma.collectionCategory.findUnique({ where: { slug } });
  if (existing) {
    await prisma.collectionCategory.update({
      where: { slug },
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

async function ensureDemoBrand(categoryId: string) {
  const hashedPassword = await argon2.hash(DEMO_BRAND_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 8,
  });

  const existingUser = await prisma.user.findUnique({
    where: { email: DEMO_BRAND_EMAIL },
    select: { id: true },
  });

  const userId = existingUser?.id ?? randomUUID();

  await prisma.user.upsert({
    where: { email: DEMO_BRAND_EMAIL },
    update: {
      password: hashedPassword,
      type: 'BRAND',
      isActive: 'Active',
    },
    create: {
      id: userId,
      email: DEMO_BRAND_EMAIL,
      username: 'brand_demo',
      firstName: 'Demo',
      lastName: 'Brand',
      password: hashedPassword,
      type: 'BRAND',
      isActive: 'Active',
    },
    select: { id: true },
  });

  await prisma.brand.upsert({
    where: { ownerId: userId },
    update: {
      name: 'Vogue Vendor',
      description: 'Premium fashion for the modern era.',
      currency: 'NGN',
    },
    create: {
      id: randomUUID(),
      name: 'Vogue Vendor',
      ownerId: userId,
      description: 'Premium fashion for the modern era.',
      currency: 'NGN',
    },
    select: { id: true },
  });

  const existingCollection = await prisma.collection.findFirst({
    where: {
      ownerId: userId,
      title: 'Demo Store Collection',
    },
    select: { id: true },
  });

  if (existingCollection) {
    await prisma.collection.update({
      where: { id: existingCollection.id },
      data: {
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        type: 'EVERYBODY',
        categoryId,
        isAvailableInStore: true,
      },
    });
  } else {
    await prisma.collection.create({
      data: {
        id: randomUUID(),
        ownerId: userId,
        title: 'Demo Store Collection',
        description: 'Seeded collection for Studio product creation.',
        status: 'PUBLISHED',
        visibility: 'PUBLIC',
        type: 'EVERYBODY',
        categoryId,
        isAvailableInStore: true,
        tags: [],
      },
      select: { id: true },
    });
  }
}

async function main() {
  const africanDesc = 'Curated collections celebrating African textiles and craftsmanship—Ankara, Kente, Aso Oke, indigo dyes—across classic, modern, and diaspora styles.';
  const westernDesc = 'Collections spanning contemporary and classic Western styles—from streetwear and casualwear to workwear, couture, and seasonal edits.';
  const deHouseDesc = 'Cozy, stay‑at‑home and lounge‑focused collections emphasizing comfort, basics, and relaxed silhouettes for everyday ease.';

  const categoryId = await upsertCategory('african-fashion', 'African Fashion', africanDesc, 1);
  await upsertCategory('western-fashion', 'Western Fashion', westernDesc, 2);
  await upsertCategory('de-house', 'De House', deHouseDesc, 3);

  await ensureDemoBrand(categoryId);
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

