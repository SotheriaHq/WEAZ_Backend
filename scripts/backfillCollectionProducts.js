require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set before running backfill.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  const products = await prisma.product.findMany({
    where: { collectionId: { not: null } },
    select: { id: true, collectionId: true },
  });

  let created = 0;
  for (const product of products) {
    const collectionId = product.collectionId;
    if (!collectionId) continue;

    const exists = await prisma.collectionProduct.findFirst({
      where: { collectionId, productId: product.id },
      select: { id: true },
    });
    if (exists) continue;

    const orderIndex = await prisma.collectionProduct.count({
      where: { collectionId },
    });

    await prisma.collectionProduct.create({
      data: {
        id: require('crypto').randomUUID(),
        collectionId,
        productId: product.id,
        orderIndex,
      },
    });
    created += 1;
  }

  console.log(`Backfill complete. Created ${created} collectionProduct rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
