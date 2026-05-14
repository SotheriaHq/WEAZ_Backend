import { Prisma } from '@prisma/client';
import { appendFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  createScriptPrismaClient,
  type ScriptPrismaClient,
} from './helpers/create-script-prisma';

type Options = {
  apply: boolean;
  limit?: number;
  brandId?: string;
  resumeFrom?: string;
  logFile?: string;
};

type Counts = {
  scanned: number;
  wouldCreate: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  moreThanSixMedia: number;
  missingCategory: number;
  missingSubCategory: number;
  missingMedia: number;
  customOrderConfigWarnings: number;
  targetMappingWarnings: number;
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
  return {
    apply,
    limit,
    brandId: getArg('--brandId'),
    resumeFrom: getArg('--resumeFrom'),
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function resolveBrandId(
  prisma: ScriptPrismaClient['prisma'],
  ownerId: string,
): Promise<string | null> {
  const brand = await prisma.brand.findUnique({
    where: { ownerId },
    select: { id: true },
  });
  return brand?.id ?? null;
}

async function syncFiltersForDesign(
  tx: Prisma.TransactionClient,
  legacyCollectionId: string,
  designId: string,
) {
  const filters = await tx.entityFilter.findMany({
    where: { entityType: 'COLLECTION', entityId: legacyCollectionId },
    select: { filterValueId: true },
  });

  for (const filter of filters) {
    await tx.entityFilter.upsert({
      where: {
        filterValueId_entityType_entityId: {
          filterValueId: filter.filterValueId,
          entityType: 'DESIGN',
          entityId: designId,
        },
      },
      update: { designId },
      create: {
        id: uuidv4(),
        filterValueId: filter.filterValueId,
        entityType: 'DESIGN',
        entityId: designId,
        designId,
      },
    });
  }
}

async function backfillOne(
  prisma: ScriptPrismaClient['prisma'],
  options: Options,
  legacy: any,
  counts: Counts,
) {
  counts.scanned += 1;
  const media = Array.isArray(legacy.medias) ? legacy.medias : [];
  if (media.length > 6) counts.moreThanSixMedia += 1;
  if (media.length === 0) counts.missingMedia += 1;
  if (!legacy.categoryId) counts.missingCategory += 1;
  if (!legacy.categoryTypeId) counts.missingSubCategory += 1;

  const existing = await prisma.design.findUnique({
    where: { legacyCollectionId: legacy.id },
    select: { id: true },
  });

  const brandId = await resolveBrandId(prisma, legacy.ownerId);
  if (options.brandId && brandId !== options.brandId) {
    counts.skipped += 1;
    return;
  }

  const customOrderConfig = await prisma.customOrderConfiguration.findUnique({
    where: {
      sourceType_sourceId: {
        sourceType: 'DESIGN',
        sourceId: legacy.id,
      },
    },
    select: { id: true },
  });
  if (customOrderConfig) {
    counts.customOrderConfigWarnings += 1;
  }

  if (!options.apply) {
    if (existing) counts.skipped += 1;
    else counts.wouldCreate += 1;
    writeLog(options, {
      event: 'dry_run_design',
      legacyCollectionId: legacy.id,
      existingDesignId: existing?.id ?? null,
      mediaCount: media.length,
      hasCustomOrderConfiguration: Boolean(customOrderConfig),
    });
    return;
  }

  try {
    const design = await prisma.$transaction(async (tx) => {
      const upserted = await tx.design.upsert({
        where: { legacyCollectionId: legacy.id },
        update: {
          ownerId: legacy.ownerId,
          brandId,
          title: legacy.title,
          description: legacy.description,
          status: legacy.status,
          archivedFromStatus: legacy.archivedFromStatus,
          visibility: legacy.visibility,
          type: legacy.type,
          categoryId: legacy.categoryId,
          categoryTypeId: legacy.categoryTypeId,
          deletedAt: legacy.deletedAt,
          deleteExpiresAt: legacy.deleteExpiresAt,
          lastActivityAt: legacy.lastActivityAt,
          draftVersion: legacy.draftVersion,
          minPrice: legacy.minPrice,
          maxPrice: legacy.maxPrice,
          customOrderEnabled: legacy.customOrderEnabled,
          tags: legacy.tags ?? [],
          saleMinPrice: legacy.saleMinPrice,
          saleMaxPrice: legacy.saleMaxPrice,
          saleStartAt: legacy.saleStartAt,
          saleEndAt: legacy.saleEndAt,
          sizingMode: legacy.sizingMode,
          rtwSizes: legacy.rtwSizes ?? [],
          rtwSizeSystem: legacy.rtwSizeSystem,
          rtwSizeType: legacy.rtwSizeType,
          customGender: legacy.customGender,
          customMeasurementKeys: legacy.customMeasurementKeys ?? [],
          customFreeformPointIds: legacy.customFreeformPointIds ?? [],
          fitPreference: legacy.fitPreference,
          targetAgeGroup: legacy.targetAgeGroup,
          metadataEditedAt: legacy.metadataEditedAt,
          threadsCount: legacy.threadsCount,
          dislikesCount: legacy.dislikesCount,
          commentsCount: legacy.commentsCount,
          collectionCollabsCount: legacy.collectionCollabsCount,
          viewsCount: legacy.viewsCount,
        },
        create: {
          id: uuidv4(),
          ownerId: legacy.ownerId,
          brandId,
          legacyCollectionId: legacy.id,
          title: legacy.title,
          description: legacy.description,
          status: legacy.status,
          archivedFromStatus: legacy.archivedFromStatus,
          visibility: legacy.visibility,
          type: legacy.type,
          categoryId: legacy.categoryId,
          categoryTypeId: legacy.categoryTypeId,
          deletedAt: legacy.deletedAt,
          deleteExpiresAt: legacy.deleteExpiresAt,
          lastActivityAt: legacy.lastActivityAt,
          draftVersion: legacy.draftVersion,
          minPrice: legacy.minPrice,
          maxPrice: legacy.maxPrice,
          customOrderEnabled: legacy.customOrderEnabled,
          tags: legacy.tags ?? [],
          saleMinPrice: legacy.saleMinPrice,
          saleMaxPrice: legacy.saleMaxPrice,
          saleStartAt: legacy.saleStartAt,
          saleEndAt: legacy.saleEndAt,
          sizingMode: legacy.sizingMode,
          rtwSizes: legacy.rtwSizes ?? [],
          rtwSizeSystem: legacy.rtwSizeSystem,
          rtwSizeType: legacy.rtwSizeType,
          customGender: legacy.customGender,
          customMeasurementKeys: legacy.customMeasurementKeys ?? [],
          customFreeformPointIds: legacy.customFreeformPointIds ?? [],
          fitPreference: legacy.fitPreference,
          targetAgeGroup: legacy.targetAgeGroup,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
          metadataEditedAt: legacy.metadataEditedAt,
          threadsCount: legacy.threadsCount,
          dislikesCount: legacy.dislikesCount,
          commentsCount: legacy.commentsCount,
          collectionCollabsCount: legacy.collectionCollabsCount,
          viewsCount: legacy.viewsCount,
        },
        select: { id: true },
      });

      for (const item of media) {
        await tx.designMedia.upsert({
          where: { legacyCollectionMediaId: item.id },
          update: {
            designId: upserted.id,
            fileUploadId: item.fileUploadId,
            orderIndex: item.orderIndex,
            mediaType: item.mediaType,
            threadsCount: item.threadsCount,
            commentsCount: item.commentsCount,
          },
          create: {
            id: uuidv4(),
            designId: upserted.id,
            fileUploadId: item.fileUploadId,
            orderIndex: item.orderIndex,
            mediaType: item.mediaType,
            legacyCollectionMediaId: item.id,
            threadsCount: item.threadsCount,
            commentsCount: item.commentsCount,
          },
        });
      }

      for (const session of legacy.draftSessions ?? []) {
        await tx.designDraftSession.upsert({
          where: { legacyCollectionDraftSessionId: session.id },
          update: {
            designId: upserted.id,
            ownerId: session.ownerId,
            sessionToken: session.sessionToken,
            deviceName: session.deviceName,
            deviceType: session.deviceType,
            startedAt: session.startedAt,
            lastHeartbeatAt: session.lastHeartbeatAt,
            expiresAt: session.expiresAt,
            isActive: session.isActive,
          },
          create: {
            id: uuidv4(),
            designId: upserted.id,
            ownerId: session.ownerId,
            sessionToken: session.sessionToken,
            deviceName: session.deviceName,
            deviceType: session.deviceType,
            startedAt: session.startedAt,
            lastHeartbeatAt: session.lastHeartbeatAt,
            expiresAt: session.expiresAt,
            isActive: session.isActive,
            legacyCollectionDraftSessionId: session.id,
          },
        });
      }

      await syncFiltersForDesign(tx, legacy.id, upserted.id);

      if (legacy.coverMediaId) {
        const cover = await tx.designMedia.findUnique({
          where: { legacyCollectionMediaId: legacy.coverMediaId },
          select: { id: true },
        });
        if (cover) {
          await tx.design.update({
            where: { id: upserted.id },
            data: { coverMediaId: cover.id },
          });
        }
      }

      return upserted;
    });

    if (existing) counts.updated += 1;
    else counts.created += 1;
    writeLog(options, {
      event: existing ? 'updated_design' : 'created_design',
      designId: design.id,
      legacyCollectionId: legacy.id,
      mediaCount: media.length,
    });
  } catch (error) {
    counts.failed += 1;
    writeLog(options, {
      event: 'failed_design',
      legacyCollectionId: legacy.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  const options = parseOptions();
  const scriptPrisma = createScriptPrismaClient();
  const prisma = scriptPrisma.prisma;
  const counts: Counts = {
    scanned: 0,
    wouldCreate: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    moreThanSixMedia: 0,
    missingCategory: 0,
    missingSubCategory: 0,
    missingMedia: 0,
    customOrderConfigWarnings: 0,
    targetMappingWarnings: 0,
  };

  writeLog(options, {
    event: 'start',
    mode: options.apply ? 'apply' : 'dry-run',
    limit: options.limit ?? null,
    brandId: options.brandId ?? null,
    resumeFrom: options.resumeFrom ?? null,
  });

  try {
    const take = options.limit ?? 500;
    const rows = await prisma.collection.findMany({
      where: {
        OR: [{ domain: 'DESIGN' }, { isAvailableInStore: false }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...(options.resumeFrom ? { cursor: { id: options.resumeFrom }, skip: 1 } : {}),
      take,
      include: {
        medias: { orderBy: { orderIndex: 'asc' } },
        draftSessions: true,
      },
    });

    for (const batch of chunk(rows, 25)) {
      for (const row of batch) {
        await backfillOne(prisma, options, row, counts);
      }
    }

    writeLog(options, { event: 'summary', ...counts });
  } finally {
    await scriptPrisma.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
