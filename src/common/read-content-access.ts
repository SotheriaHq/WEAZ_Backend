import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { ReadResource, FileReadResource } from 'src/auth/access/read-resource-context';
import { assertCurrentFileReads } from './file-read-response-access';
import { resourceUuid } from './content-audience';
import { approvedPrivateCollectionOwners } from './private-collection-owners';

const chunkSize = 100;
const batches = function* <T>(items: T[]) { for (let start = 0; start < items.length; start += chunkSize) yield items.slice(start, start + chunkSize); };
const denied = () => { throw new ForbiddenException('Access to this content changed. Refresh before continuing.'); };

/** Re-evaluate the exact successful domain checks before a read emits. IDs are
 * grouped by entity and queried in batches, never one query per returned item. */
export async function assertCurrentReadContent(prisma: PrismaService, resources: ReadResource[], depth = 0): Promise<void> {
  if (!resources.length) return;
  if (resources.length > 1024 || depth > 2 || resources.some(resource => !resourceUuid.test(resource.id))) denied();
  const byType = new Map<ReadResource['type'], ReadResource[]>();
  for (const resource of resources) {
    const group = byType.get(resource.type);
    if (group) group.push(resource); else byType.set(resource.type, [resource]);
  }
  for (const [type, items] of byType) {
    for (const ids of batches([...new Set(items.map(item => item.id))])) {
      const selected = items.filter(item => ids.includes(item.id));
      if (type === 'FILE') {
        const files = selected.filter((item): item is FileReadResource => item.type === 'FILE');
        const sources = files.flatMap(item => item.source ? [item.source] : []);
        if (sources.some(source => !resourceUuid.test(source.id))) denied();
        await assertCurrentFileReads(prisma, files);
        await assertCurrentReadContent(prisma, sources, depth + 1);
      } else if (type === 'COMMENT') {
        const rows = await prisma.commentV2.findMany({ where: { id: { in: ids } }, select: { id: true, targetType: true, targetId: true } });
        await assertCurrentReadContent(prisma, selected.map(item => {
          const row = rows.find(row => row.id === item.id); if (!row) return denied();
          return { ...item, type: row.targetType, id: row.targetId };
        }), depth + 1);
      } else if (type === 'COLLECTION_MEDIA') {
        const rows = await prisma.collectionMedia.findMany({ where: { id: { in: ids } }, select: { id: true, collectionId: true } });
        await assertCurrentReadContent(prisma, selected.map(item => {
          const row = rows.find(row => row.id === item.id); if (!row) return denied();
          return { ...item, type: 'COLLECTION', id: row.collectionId };
        }), depth + 1);
      } else if (type === 'POST') {
        const rows = await prisma.post.findMany({ where: { id: { in: ids } }, select: { id: true } });
        const found = new Set(rows.map(row => row.id)); if (ids.some(id => !found.has(id))) denied();
      } else if (type === 'PRODUCT') {
        const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: {
          id: true, brand: { select: { ownerId: true } }, isActive: true, deletedAt: true, archivedAt: true, publishAt: true,
        } });
        const found = new Map(rows.map(row => [row.id, row])); const now = new Date();
        for (const item of selected) {
          const row = found.get(item.id);
          if (!row || (row.brand.ownerId !== item.viewer &&
            (row.deletedAt || row.archivedAt || !row.isActive || (row.publishAt && row.publishAt > now)))) denied();
        }
      } else if (type === 'STORE_COLLECTION') {
        const rows = await prisma.storeCollection.findMany({ where: { id: { in: ids } },
          select: { id: true, ownerId: true, status: true, visibility: true, deletedAt: true } });
        const found = new Map(rows.map(row => [row.id, row]));
        for (const item of selected) {
          const row = found.get(item.id);
          if (!row || (row.deletedAt && !(item.type !== 'FILE' && item.allowDeletedByOwner && row.ownerId === item.viewer)) || (row.ownerId !== item.viewer &&
            (row.status !== 'PUBLISHED' || row.visibility !== 'PUBLIC'))) denied();
        }
      } else if (type === 'COLLECTION' || type === 'DESIGN') {
        const rows = await prisma.collection.findMany({ where: { id: { in: ids } },
          select: { id: true, ownerId: true, status: true, visibility: true, deletedAt: true } });
        const found = new Map(rows.map(row => [row.id, row]));
        const privateItems = selected.filter(item => {
          const row = found.get(item.id);
          if (!row || (row.deletedAt && !(item.type !== 'FILE' && item.allowDeletedByOwner && row.ownerId === item.viewer))) return denied();
          if (item.viewer === row.ownerId || (row.status === 'PUBLISHED' && row.visibility === 'PUBLIC')) return false;
          if (row.status !== 'PUBLISHED' || !item.viewer || !resourceUuid.test(item.viewer)) return denied();
          return true;
        });
        if (!privateItems.length) continue;
        const viewers = [...new Set(privateItems.map(item => item.viewer!))];
        const owners = [...new Set(privateItems.map(item => found.get(item.id)!.ownerId))];
        const approved = new Set<string>();
        for (const viewerIds of batches(viewers)) {
          for (const key of await approvedPrivateCollectionOwners(prisma, viewerIds, owners)) approved.add(key);
        }
        if (privateItems.some(item => !approved.has(`${item.viewer}:${found.get(item.id)!.ownerId}`))) denied();
      } else denied();
    }
  }
}
