import { Queue } from 'bullmq';
import { createScriptPrismaClient } from './helpers/create-script-prisma';
import { buildRedisConnectionFromEnv } from '../src/queue/queue.config';
import {
  IMAGE_PROCESSING_QUEUE,
  IMAGE_PROCESS_BATCH_JOB,
} from '../src/queue/queue.constants';

/**
 * Enqueue image-variant generation (thumb/card/detail/zoom/avatar/banner in
 * WEBP/AVIF) for existing image uploads that have no FileVariant rows yet.
 * The worker process (weaz-worker) does the actual Sharp work — keep it
 * running while this drains.
 *
 * Usage:
 *   npx ts-node scripts/backfill-image-variants.ts --dry-run
 *   npx ts-node scripts/backfill-image-variants.ts --apply [--limit=500] [--batch-size=20]
 *
 * On the SIT box prefix with TS_NODE_TRANSPILE_ONLY=1 (ts-node OOMs otherwise).
 */

const EXCLUDED_FILE_TYPES = [
  'POST_VIDEO',
  'REVIEW_VIDEO',
  'DOCUMENT',
  'MESSAGE_DOCUMENT',
  'BRAND_VERIFICATION',
];

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = getArg('--limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  const batchSizeArg = getArg('--batch-size');
  const batchSize = batchSizeArg ? Number(batchSizeArg) : 20;
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
    throw new Error('--batch-size must be 1..100.');
  }

  const scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;

  const candidates = await (prisma as any).fileUpload.findMany({
    where: {
      mimeType: { startsWith: 'image/' },
      fileType: { notIn: EXCLUDED_FILE_TYPES },
      originalDeletedAt: null,
      s3Key: { not: '' },
      processingStatus: { not: 'FAILED' },
      variants: { none: {} },
    },
    select: { id: true, fileType: true, mimeType: true },
    orderBy: { createdAt: 'desc' },
    ...(limit ? { take: limit } : {}),
  });

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      mode: apply ? 'apply' : 'dry-run',
      candidates: candidates.length,
      byFileType: candidates.reduce(
        (acc: Record<string, number>, row: any) => {
          acc[row.fileType] = (acc[row.fileType] ?? 0) + 1;
          return acc;
        },
        {},
      ),
    }),
  );

  if (!apply || candidates.length === 0) {
    await scriptPrisma.disconnect();
    return;
  }

  const queue = new Queue(IMAGE_PROCESSING_QUEUE, {
    connection: buildRedisConnectionFromEnv(),
  });

  let enqueued = 0;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const fileIds = candidates
      .slice(i, i + batchSize)
      .map((row: any) => row.id);
    // force=true: existing rows are already READY, which processOne skips
    // without force even when no variants exist yet.
    await queue.add(
      IMAGE_PROCESS_BATCH_JOB,
      { fileIds, force: true },
      { attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
    );
    enqueued += fileIds.length;
  }

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      enqueuedFiles: enqueued,
      jobs: Math.ceil(candidates.length / batchSize),
      note: 'weaz-worker drains the image-processing queue; watch pm2 logs weaz-worker',
    }),
  );

  await queue.close();
  await scriptPrisma.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
