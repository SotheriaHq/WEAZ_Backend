import { FileUpload, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DESIGN_MAX_MEDIA_COUNT } from './dto/create-collection.dto';

type FinalizedMedia = {
  file: Pick<FileUpload, 'id' | 'fileType'>;
  orderIndex: number | null;
  viewSlot: unknown;
};

/** Attach a verified batch once; storage/capability checks stay in UploadService. */
export async function attachFinalizedMedia(
  tx: Prisma.TransactionClient,
  collection: { id: string; ownerId: string },
  userId: string,
  entries: FinalizedMedia[],
  integrity?: {
    normalizeViewSlot(value: any, index: number): any;
    mediaPurposeForSlot(slot: any): any;
  },
) {
  if (!entries.length) return;
  // Serialize retries before reading existing media. A later READ COMMITTED
  // statement sees links committed by the preceding finalizer.
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "_id" AS id FROM "Collection"
    WHERE "_id" = ${collection.id}::uuid FOR UPDATE
  `);
  if (!locked.length) throw new NotFoundException('Collection not found');
  const [existing, brand] = await Promise.all([
    tx.collectionMedia.findMany({
      where: { collectionId: collection.id },
      select: { fileUploadId: true },
    }),
    tx.brand.findUnique({
      where: { ownerId: collection.ownerId },
      select: { id: true },
    }),
  ]);
  const attached = new Set(existing.map((entry) => entry.fileUploadId));
  const data: Prisma.CollectionMediaCreateManyInput[] = [];
  for (const [index, entry] of entries.entries()) {
    if (attached.has(entry.file.id)) continue;
    attached.add(entry.file.id);
    const orderIndex =
      typeof entry.orderIndex === 'number' ? entry.orderIndex : index;
    const viewSlot = integrity?.normalizeViewSlot(entry.viewSlot, orderIndex);
    data.push({
      id: randomUUID(),
      collectionId: collection.id,
      fileUploadId: entry.file.id,
      orderIndex,
      mediaType: entry.file.fileType,
      viewSlot,
      mediaPurpose: viewSlot
        ? integrity?.mediaPurposeForSlot(viewSlot)
        : undefined,
      reviewStatus: 'APPROVED',
      createdById: userId,
      brandId: brand?.id,
    });
  }
  if (!data.length) return;
  // Issuing upload slots only reads this count, so two saves can both pass that
  // check. Under this row lock the count is final.
  if (existing.length + data.length > DESIGN_MAX_MEDIA_COUNT) {
    throw new BadRequestException(
      `Maximum ${DESIGN_MAX_MEDIA_COUNT} files per design`,
    );
  }
  // Do not skip slot conflicts: they are a real content-integrity failure.
  await tx.collectionMedia.createMany({ data });
}
