import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

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

async function main() {
  const africanDesc = 'Curated collections celebrating African textiles and craftsmanship—Ankara, Kente, Aso Oke, indigo dyes—across classic, modern, and diaspora styles.';
  const westernDesc = 'Collections spanning contemporary and classic Western styles—from streetwear and casualwear to workwear, couture, and seasonal edits.';
  const deHouseDesc = 'Cozy, stay‑at‑home and lounge‑focused collections emphasizing comfort, basics, and relaxed silhouettes for everyday ease.';

  await upsertCategory('african-fashion', 'African Fashion', africanDesc, 1);
  await upsertCategory('western-fashion', 'Western Fashion', westernDesc, 2);
  await upsertCategory('de-house', 'De House', deHouseDesc, 3);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

