import { appendFileSync } from 'fs';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

type Options = {
  brandId?: string;
  limit?: number;
  logFile?: string;
};

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function parseOptions(): Options {
  const limitArg = getArg('--limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  return {
    brandId: getArg('--brandId'),
    limit,
    logFile: getArg('--logFile'),
  };
}

function writeLog(options: Options, event: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  console.log(line);
  if (options.logFile) {
    appendFileSync(options.logFile, `${line}\n`);
  }
}

async function main() {
  const options = parseOptions();
  const scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;
  const summary = {
    legacyDesignLikeCollections: 0,
    explicitDesignRecords: 0,
    mappedRecords: 0,
    unmappedLegacyRecords: 0,
    duplicateMappings: 0,
    mediaMismatches: 0,
    customOrderConfigMismatches: 0,
    categoryMismatches: 0,
    subCategoryMismatches: 0,
    statusMismatches: 0,
    draftSessionMismatches: 0,
    targetMismatches: 0,
    unsafeToSwitch: 0,
  };

  writeLog(options, {
    event: 'start',
    brandId: options.brandId ?? null,
    limit: options.limit ?? null,
  });

  try {
    const brand = options.brandId
      ? await prisma.brand.findUnique({
          where: { id: options.brandId },
          select: { ownerId: true },
        })
      : null;

    const legacyRows = await prisma.collection.findMany({
      where: {
        OR: [{ domain: 'DESIGN' }, { isAvailableInStore: false }],
        ...(brand?.ownerId ? { ownerId: brand.ownerId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: options.limit ?? 500,
      include: {
        medias: true,
        draftSessions: true,
      },
    });

    summary.legacyDesignLikeCollections = legacyRows.length;
    summary.explicitDesignRecords = await prisma.design.count({
      where: options.brandId ? { brandId: options.brandId } : {},
    });

    const duplicateMappings = await prisma.$queryRaw<Array<{ legacyCollectionId: string; count: bigint }>>`
      SELECT "legacyCollectionId", COUNT(*)::bigint AS count
      FROM "Design"
      WHERE "legacyCollectionId" IS NOT NULL
      GROUP BY "legacyCollectionId"
      HAVING COUNT(*) > 1
    `;
    summary.duplicateMappings = duplicateMappings.length;

    for (const legacy of legacyRows) {
      const design = await prisma.design.findUnique({
        where: { legacyCollectionId: legacy.id },
        include: {
          medias: true,
          draftSessions: true,
        },
      });

      if (!design) {
        summary.unmappedLegacyRecords += 1;
        summary.unsafeToSwitch += 1;
        writeLog(options, {
          event: 'unmapped_legacy_design',
          legacyCollectionId: legacy.id,
          title: legacy.title,
        });
        continue;
      }

      summary.mappedRecords += 1;

      if (legacy.medias.length !== design.medias.length) {
        summary.mediaMismatches += 1;
        summary.unsafeToSwitch += 1;
      }
      if (legacy.categoryId !== design.categoryId) {
        summary.categoryMismatches += 1;
        summary.unsafeToSwitch += 1;
      }
      if (legacy.categoryTypeId !== design.categoryTypeId) {
        summary.subCategoryMismatches += 1;
        summary.unsafeToSwitch += 1;
      }
      if (legacy.status !== design.status) {
        summary.statusMismatches += 1;
        summary.unsafeToSwitch += 1;
      }
      if (legacy.draftSessions.length !== design.draftSessions.length) {
        summary.draftSessionMismatches += 1;
      }

      const legacyConfig = await prisma.customOrderConfiguration.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: 'DESIGN',
            sourceId: legacy.id,
          },
        },
        select: { id: true },
      });
      const explicitConfig = await prisma.customOrderConfiguration.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: 'DESIGN',
            sourceId: design.id,
          },
        },
        select: { id: true },
      });
      if (legacyConfig && !explicitConfig) {
        summary.customOrderConfigMismatches += 1;
      }

      const legacySavedCount = await prisma.savedItem.count({
        where: { targetType: 'COLLECTION', targetId: legacy.id },
      });
      const explicitSavedCount = await prisma.savedItem.count({
        where: { targetType: 'DESIGN', targetId: design.id },
      });
      if (explicitSavedCount < legacySavedCount) {
        summary.targetMismatches += 1;
      }
    }

    writeLog(options, { event: 'summary', ...summary });
  } finally {
    await scriptPrisma.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
