require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

(async () => {
  const products = await prisma.product.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      brandId: true,
      collectionId: true,
      isActive: true,
      deletedAt: true,
      createdAt: true,
    },
  });

  console.log('recentProducts', products);
  const count = await prisma.product.count();
  console.log('productCount', count);

  await prisma.$disconnect();
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
