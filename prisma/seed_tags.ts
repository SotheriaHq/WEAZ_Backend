import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { FILTER_TAG_SUGGESTIONS } from '../src/categories/default-taxonomy';

/**
 * Standalone, idempotent platform-tag seed.
 *
 * Why this exists separately from `prisma/seed.ts`:
 * `GET /tags` (TagsService.getPopularTags) only returns rows from the `tag`
 * table with status APPROVED / not banned. On a DB where the tag table is empty
 * the endpoint returns `[]`, so the web hashtag field and the native hashtag
 * sheet show no seeded/system tags. The full `prisma db seed` would also create
 * demo brands/users/collections, which we don't want to do on a populated DB.
 *
 * This script ONLY upserts the platform tags (no demo data, no destructive
 * writes), so it is safe to run against any environment.
 *
 *   npm run prisma:seed:tags
 */

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed tags.');
}

const pool = new Pool({ connectionString: datasourceUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Keep this list in sync with ensureDefaultTags() in prisma/seed.ts.
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

async function seedTags(): Promise<number> {
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

  for (const tagName of allTags) {
    const normalizedName = tagName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalizedName) continue;
    const displayName = tagName
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());

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

async function main() {
  const count = await seedTags();
  const [total, approved] = await Promise.all([
    (prisma as any).tag.count(),
    (prisma as any).tag.count({ where: { status: 'APPROVED', isBanned: false } }),
  ]);
  console.log(`Seeded ${count} platform tags.`);
  console.log(`Tag table now has ${total} rows (${approved} APPROVED & visible).`);
}

main()
  .catch((error) => {
    console.error('Tag seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
