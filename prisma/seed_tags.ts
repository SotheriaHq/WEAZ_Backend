import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { withUtcDatabaseUrl } from '../src/prisma/database-connection';
import { randomUUID } from 'crypto';
import { FILTER_TAG_SUGGESTIONS } from '../src/categories/default-taxonomy';

/** Shared, idempotent platform-tag bootstrap. Existing moderation decisions are never overwritten. */

const ADDITIONAL_TAGS = [
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

export async function seedPlatformTags(prisma: PrismaClient): Promise<number> {
  const tagSet = new Set<string>();
  for (const suggestions of Object.values(FILTER_TAG_SUGGESTIONS)) {
    for (const tag of suggestions) {
      tagSet.add(tag);
    }
  }
  for (const tag of ADDITIONAL_TAGS) {
    tagSet.add(tag);
  }

  const allTags = Array.from(tagSet);
  console.log(`Seeding ${allTags.length} platform tags...`);

  await prisma.tag.createMany({
    data: allTags.map((tagName) => ({
      id: randomUUID(), normalizedName: tagName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      displayName: tagName.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      status: 'APPROVED' as const, isBanned: false, usageCount: 0, createdById: null, aliasOfTagId: null,
    })),
    skipDuplicates: true,
  });

  return allTags.length;
}

if (require.main === module) {
  const datasourceUrl = process.env.DATABASE_URL;
  if (!datasourceUrl) throw new Error('DATABASE_URL must be set to seed tags.');
  const pool = new Pool({ connectionString: withUtcDatabaseUrl(datasourceUrl) });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  seedPlatformTags(prisma)
    .then((count) => console.log(`Seeded ${count} platform tags; existing moderation settings preserved.`))
    .catch(() => { console.error('Tag seed failed.'); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); await pool.end(); });
}
