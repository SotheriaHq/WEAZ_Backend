import { appendFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

type Options = {
  apply: boolean;
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
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run');
  if (apply && dryRun) {
    throw new Error('Use either --apply or --dry-run, not both.');
  }
  const limitArg = getArg('--limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  return { apply, limit, logFile: getArg('--logFile') };
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
  const counts = {
    savedItemsScanned: 0,
    savedItemsWouldCreate: 0,
    savedItemsCreated: 0,
    savedItemsSkipped: 0,
    dailyAggregatesScanned: 0,
    dailyAggregatesWouldCreate: 0,
    dailyAggregatesCreated: 0,
    quarantinedThreadsScanned: 0,
    quarantinedThreadsWouldCreate: 0,
    quarantinedThreadsCreated: 0,
    commentsDeferred: 0,
    ambiguousSkipped: 0,
  };

  writeLog(options, {
    event: 'start',
    mode: options.apply ? 'apply' : 'dry-run',
    limit: options.limit ?? null,
    note: 'This script preserves legacy target rows and adds explicit DESIGN mirrors only where a Design.legacyCollectionId mapping exists.',
  });

  try {
    const savedItems = await prisma.savedItem.findMany({
      where: { targetType: 'COLLECTION' },
      orderBy: { createdAt: 'asc' },
      take: options.limit ?? 500,
    });

    for (const item of savedItems) {
      counts.savedItemsScanned += 1;
      const design = await prisma.design.findUnique({
        where: { legacyCollectionId: item.targetId },
        select: { id: true },
      });
      if (!design) {
        counts.ambiguousSkipped += 1;
        continue;
      }
      const existing = await prisma.savedItem.findUnique({
        where: {
          userId_targetType_targetId: {
            userId: item.userId,
            targetType: 'DESIGN',
            targetId: design.id,
          },
        },
      });
      if (existing) {
        counts.savedItemsSkipped += 1;
        continue;
      }
      if (!options.apply) {
        counts.savedItemsWouldCreate += 1;
        continue;
      }
      await prisma.savedItem.create({
        data: {
          id: uuidv4(),
          userId: item.userId,
          targetType: 'DESIGN',
          targetId: design.id,
          createdAt: item.createdAt,
        },
      });
      counts.savedItemsCreated += 1;
    }

    const aggregates = await prisma.dailyThreadAggregate.findMany({
      where: { contentType: 'COLLECTION' },
      orderBy: { date: 'asc' },
      take: options.limit ?? 500,
    });
    for (const aggregate of aggregates) {
      counts.dailyAggregatesScanned += 1;
      const design = await prisma.design.findUnique({
        where: { legacyCollectionId: aggregate.contentId },
        select: { id: true },
      });
      if (!design) {
        counts.ambiguousSkipped += 1;
        continue;
      }
      const existing = await prisma.dailyThreadAggregate.findUnique({
        where: {
          contentType_contentId_date: {
            contentType: 'DESIGN',
            contentId: design.id,
            date: aggregate.date,
          },
        },
      });
      if (existing) continue;
      if (!options.apply) {
        counts.dailyAggregatesWouldCreate += 1;
        continue;
      }
      await prisma.dailyThreadAggregate.create({
        data: {
          contentType: 'DESIGN',
          contentId: design.id,
          date: aggregate.date,
          count: aggregate.count,
        },
      });
      counts.dailyAggregatesCreated += 1;
    }

    const quarantined = await prisma.quarantinedThread.findMany({
      where: { contentType: 'COLLECTION' },
      orderBy: { createdAt: 'asc' },
      take: options.limit ?? 500,
    });
    for (const item of quarantined) {
      counts.quarantinedThreadsScanned += 1;
      const design = await prisma.design.findUnique({
        where: { legacyCollectionId: item.contentId },
        select: { id: true },
      });
      if (!design) {
        counts.ambiguousSkipped += 1;
        continue;
      }
      const existing = await prisma.quarantinedThread.findFirst({
        where: {
          userId: item.userId,
          contentType: 'DESIGN',
          contentId: design.id,
          createdAt: item.createdAt,
        },
      });
      if (existing) continue;
      if (!options.apply) {
        counts.quarantinedThreadsWouldCreate += 1;
        continue;
      }
      await prisma.quarantinedThread.create({
        data: {
          userId: item.userId,
          contentType: 'DESIGN',
          contentId: design.id,
          reason: item.reason,
          createdAt: item.createdAt,
        },
      });
      counts.quarantinedThreadsCreated += 1;
    }

    counts.commentsDeferred = await prisma.commentV2.count({
      where: { targetType: { in: ['COLLECTION', 'COLLECTION_MEDIA'] } },
    });

    writeLog(options, {
      event: 'summary',
      ...counts,
      commentsNote:
        'Comment backfill is intentionally deferred because duplicating threaded comments requires parent/reply and counter remapping.',
    });
  } finally {
    await scriptPrisma.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
