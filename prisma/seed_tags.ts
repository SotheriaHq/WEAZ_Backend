import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { withUtcDatabaseUrl } from '../src/prisma/database-connection';
import { randomUUID } from 'crypto';
import { FILTER_TAG_SUGGESTIONS } from '../src/categories/default-taxonomy';
import { normalizeTag } from '../src/common/utils/tag-validator';

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

  // Seed names use the same normalizer as runtime tagging, so a shopper's
  // "#african-fashion" matches the approved platform tag.
  const canonical = allTags.map((tagName) => ({
    tagName,
    name: normalizeTag(tagName),
    legacy: tagName.toLowerCase().replace(/[^a-z0-9]/g, ''),
  }));

  // Bounded repair of rows an older seed wrote with separators stripped: only
  // seed-owned (no creator), never used, approved rows whose canonical name is
  // still free. Anything else is left for a person to decide.
  let renamed = 0;
  for (const tag of canonical) {
    if (tag.legacy === tag.name) continue;
    const result = await prisma.$executeRaw`
      UPDATE "Tag" SET "normalizedName" = ${tag.name}, "updatedAt" = NOW()
      WHERE "normalizedName" = ${tag.legacy} AND "createdById" IS NULL AND status = 'APPROVED'
        AND "usageCount" = 0 AND NOT EXISTS (SELECT 1 FROM "TagBinding" b WHERE b."tagId" = "Tag"."_id")
        AND NOT EXISTS (SELECT 1 FROM "Tag" other WHERE other."normalizedName" = ${tag.name})`;
    renamed += result;
  }
  if (renamed > 0) console.log(`Renamed ${renamed} legacy platform tags to their canonical names`);

  await prisma.tag.createMany({
    data: canonical.map(({ tagName, name }) => ({
      id: randomUUID(), normalizedName: name,
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
