import { loadByIds } from './bulk-read.util';
import { SavedItemsService } from '../users/saved-items.service';
import { SavedItemTypeDto } from '../users/dto/create-saved-item.dto';
import { UploadController } from '../upload/upload.controller';
import { BrandPermissionService } from '../brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from '../brands/permissions/brand-permissions';

describe('bounded bulk hydration', () => {
  it('deduplicates IDs and bounds serial batches to 500, including empty input', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => String(i));
    const read = jest.fn(async (batch: string[]) => batch.map((id) => ({ id })));
    expect((await loadByIds([...ids, ids[0]], read)).size).toBe(1001);
    expect(read.mock.calls.map(([batch]) => batch.length)).toEqual([500, 500, 1]);
    await loadByIds([], read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('hydrates 100 saved products with one product read, preserving order and missing targets', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, targetId: `p${i}`, targetType: SavedItemTypeDto.PRODUCT }));
    const prisma: any = {
      savedItem: { findMany: jest.fn().mockResolvedValue(items) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p2', name: 'Jacket', price: '120.00', salePrice: '90.50', images: [], brand: null }]) },
      collection: { findMany: jest.fn() }, collectionMedia: { findMany: jest.fn() },
    };
    const result = await new SavedItemsService(prisma).getUserSavedItems('viewer');
    expect(result.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(result[2]).toMatchObject({ title: 'Jacket', price: 90.5 });
    expect(result[0]).toEqual(items[0]);
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.collection.findMany).not.toHaveBeenCalled();
    expect(prisma.collectionMedia.findMany).not.toHaveBeenCalled();
    expect(prisma.savedItem.findMany.mock.calls[0][0].where).toEqual({ userId: 'viewer' });
  });

  it('retains invalid/private URL entries as null and makes one public-only batch call', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const privateId = '00000000-0000-0000-0000-000000000002';
    const uploads: any = { getBatchPublicSignedUrls: jest.fn().mockResolvedValue(new Map([[id, 'public-url']])) };
    const result = await new UploadController(uploads, {} as any).getPublicSignedUrls({ fileIds: [id, 'bad-id', id, privateId] });
    expect(uploads.getBatchPublicSignedUrls).toHaveBeenCalledWith([id, privateId]);
    expect(uploads.getBatchPublicSignedUrls).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([{ fileId: id, url: 'public-url' }, { fileId: 'bad-id', url: null }, { fileId: privateId, url: null }]);
  });

  it('resolves owners, role defaults and explicit grants with two reads and canonical permission rules', async () => {
    const member = (brandId: string, role: string, permissions: string[] = []) => ({
      id: brandId, brandId, userId: 'viewer', role, status: 'ACTIVE',
      permissionGrants: permissions.map((permissionCode) => ({ permissionCode })),
    });
    const prisma: any = {
      brand: { findMany: jest.fn().mockResolvedValue([{ id: 'owned' }]) },
      brandMember: { findMany: jest.fn().mockResolvedValue([
        member('owned', 'VIEWER'), member('support', 'SUPPORT_AGENT'), member('viewer', 'VIEWER'),
        member('granted', 'VIEWER', [BRAND_PERMISSIONS.MESSAGES_READ]), member('unknown-grant', 'VIEWER', ['not.a.permission']),
      ]) },
    };
    const result = await new BrandPermissionService(prisma).getBrandIdsWithPermission('viewer', BRAND_PERMISSIONS.MESSAGES_READ);
    expect(result).toEqual(['owned', 'support', 'granted']);
    expect(prisma.brand.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.brandMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.brandMember.findMany.mock.calls[0][0].where).toEqual({ userId: 'viewer', status: 'ACTIVE' });
  });
});
