import type { PrismaService } from 'src/prisma/prisma.service';
import { rememberReadResource } from 'src/auth/access/read-resource-context';
import { approvedPrivateCollectionOwners } from './private-collection-owners';

export type ContentTarget = 'POST' | 'COLLECTION' | 'COLLECTION_MEDIA' | 'DESIGN' | 'PRODUCT' | 'COMMENT';
export const resourceUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const anonymous = 'anonymous';

/** Bounded audience query shared by HTTP content checks and realtime. Private
 * collection approval follows the existing owner-scoped Collections contract. */
export async function contentAudience(prisma: PrismaService, type: ContentTarget, id: string,
  viewers: readonly string[]): Promise<Set<string>> {
  if (viewers.length > 100) throw new RangeError('Content audience must be queried in batches');
  const none = () => new Set<string>();
  if (!resourceUuid.test(id) || !viewers.length) return none();
  if (type === 'COMMENT') {
    const comment = await prisma.commentV2.findUnique({ where: { id }, select: { targetType: true, targetId: true } });
    return comment ? contentAudience(prisma, comment.targetType, comment.targetId, viewers) : none();
  }
  if (type === 'COLLECTION_MEDIA') {
    const media = await prisma.collectionMedia.findUnique({ where: { id }, select: { collectionId: true } });
    return media ? contentAudience(prisma, 'COLLECTION', media.collectionId, viewers) : none();
  }
  if (type === 'POST') {
    return await prisma.post.findUnique({ where: { id }, select: { id: true } }) ? new Set(viewers) : none();
  }
  if (type === 'PRODUCT') {
    const product = await prisma.product.findUnique({ where: { id }, select: {
      brand: { select: { ownerId: true } }, isActive: true, deletedAt: true, archivedAt: true, publishAt: true,
    } });
    if (!product) return none();
    if (!product.deletedAt && !product.archivedAt && product.isActive && (!product.publishAt || product.publishAt <= new Date()))
      return new Set(viewers);
    return new Set(viewers.filter(viewer => viewer === product.brand.ownerId));
  }
  if (type !== 'COLLECTION' && type !== 'DESIGN') return none();
  const collection = await prisma.collection.findUnique({ where: { id },
    select: { ownerId: true, status: true, visibility: true, deletedAt: true } });
  if (!collection || collection.deletedAt) return none();
  if (collection.status === 'PUBLISHED' && collection.visibility === 'PUBLIC') return new Set(viewers);
  const allowed = new Set(viewers.filter(viewer => viewer === collection.ownerId));
  const candidates = viewers.filter(viewer => viewer !== collection.ownerId && resourceUuid.test(viewer));
  if (collection.status !== 'PUBLISHED' || !candidates.length) return allowed;
  const approvals = await approvedPrivateCollectionOwners(prisma, candidates, [collection.ownerId]);
  for (const viewer of candidates) if (approvals.has(`${viewer}:${collection.ownerId}`)) allowed.add(viewer);
  return allowed;
}

export async function canViewContent(prisma: PrismaService, type: ContentTarget, id: string, viewer?: string): Promise<boolean> {
  const key = viewer ?? anonymous;
  const allowed = (await contentAudience(prisma, type, id, [key])).has(key);
  if (allowed) rememberReadResource({ type, id, viewer });
  return allowed;
}

/** Store collections have a separate table and no private-viewer approval.
 * Keep their existing owner-or-published/public rule distinct from designs. */
export async function canViewStoreContent(prisma: PrismaService, id: string, viewer?: string): Promise<boolean> {
  if (!resourceUuid.test(id)) return false;
  const collection = await prisma.storeCollection.findUnique({ where: { id },
    select: { ownerId: true, status: true, visibility: true, deletedAt: true } });
  const allowed = Boolean(collection && !collection.deletedAt &&
    (viewer === collection.ownerId || (collection.status === 'PUBLISHED' && collection.visibility === 'PUBLIC')));
  if (allowed) rememberReadResource({ type: 'STORE_COLLECTION', id, viewer });
  return allowed;
}
