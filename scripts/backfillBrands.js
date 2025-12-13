const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');

(async () => {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { type: 'BRAND' },
      select: { id: true, brandFullName: true, firstName: true, lastName: true },
    });
    let created = 0;
    for (const u of users) {
      const existing = await prisma.brand.findUnique({ where: { ownerId: u.id } });
      if (existing) continue;
      const name = (u.brandFullName || `${u.firstName || ''} ${u.lastName || ''}`).trim() || u.id;
      await prisma.brand.create({
        data: {
          id: randomUUID(),
          name,
          ownerId: u.id,
          currency: 'NGN',
          isStoreOpen: false,
        },
      });
      created += 1;
    }
    console.log('brand backfill created', created);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
