import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { FileReadResource } from 'src/auth/access/read-resource-context';
import { UploadReadAccess } from 'src/upload/upload-read-access';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';

const denied = (): never => { throw new ForbiddenException('Access to this file changed. Refresh before continuing.'); };

/** Called with at most 100 file IDs. Reuse admission policy and batch shared
 * grants/attachments by viewer instead of issuing one query per image. */
export async function assertCurrentFileReads(prisma: PrismaService, items: FileReadResource[]) {
  const policy = new UploadReadAccess(prisma, true, new BrandPermissionService(prisma));
  const ids = [...new Set(items.map(item => item.id))];
  const files = await prisma.fileUpload.findMany({ where: { id: { in: ids } }, include: policy.publicFileAccessInclude() });
  const byId = new Map(files.map(file => [file.id, file]));
  const variantKeys = [...new Set(items.flatMap(item => item.variantKey ? [item.variantKey] : []))];
  const variants = variantKeys.length ? await prisma.fileVariant.findMany({ where: { s3Key: { in: variantKeys },
    fileUploadId: { in: ids } }, select: { s3Key: true, fileUploadId: true, assetVersion: true } }) : [];
  const productIds = [...new Set(items.flatMap(item => item.source?.type === 'PRODUCT' ? [item.source.id] : []))];
  const products = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } },
    select: { id: true, thumbnail: true, images: true } }) : [];
  const pending = new Map<string, { viewer: string; enabled: boolean; administrator: boolean; ids: string[] }>();
  for (const item of items) {
    const file = byId.get(item.id);
    if (!file || !policy.isDisplayableStoredFile(file) || file.s3Key !== item.key ||
      !Number.isSafeInteger(item.assetVersion) || file.assetVersion !== item.assetVersion ||
      (item.expectedFileType !== undefined && file.fileType !== item.expectedFileType)) denied();
    if (item.variantKey && !variants.some(variant => variant.s3Key === item.variantKey &&
      variant.fileUploadId === item.id && variant.assetVersion === file.assetVersion)) denied();
    if (item.source) {
      const source = item.source;
      // The containing entity authorizes this particular file association.
      // Domain visibility is rechecked by assertCurrentReadContent next.
      const linked = source.type === 'PRODUCT'
        ? file.productMedias.some(media => media.product.id === source.id) || products.some(product =>
          product.id === source.id && (product.thumbnail?.trim() === item.id || product.images.some(image => image.trim() === item.id)))
        : file.collectionMedias.some(media => media.collection.id === source.id);
      if (!linked) denied();
      continue;
    }
    if (policy.canReturnPublicFileUrl(file)) continue;
    if (item.publicOnly || !item.viewer) denied();
    // Current actor role/revision is checked after all resource waits.
    if (file.userId === item.viewer) continue;
    const administrator = ['Admin', 'SuperAdmin'].includes(item.role ?? '');
    const key = `${item.viewer}:${item.privateCollectionsEnabled}:${administrator}`;
    const group = pending.get(key);
    if (group) group.ids.push(item.id);
    else pending.set(key, { viewer: item.viewer, enabled: item.privateCollectionsEnabled, administrator, ids: [item.id] });
  }
  for (const group of pending.values()) {
    const access = new UploadReadAccess(prisma, group.enabled, new BrandPermissionService(prisma));
    const permitted = await access.loadSharedViewerFileIds(group.ids, group.viewer);
    const remaining = group.ids.filter(id => !permitted.has(id));
    const adminIds = remaining.length && group.administrator ? await access.loadAdministratorFileIds(remaining, group.viewer) : new Set<string>();
    if (remaining.some(id => !adminIds.has(id))) denied();
  }
}
