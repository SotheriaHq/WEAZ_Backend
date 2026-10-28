import { StoreService } from './store.service';
import type { BulkProductTaxonomy } from '../collections/bulk-import-query';

describe('operation-local bulk product taxonomy', () => {
  const snapshot = (): BulkProductTaxonomy => ({
    requestedCategoryId: 'category',
    requestedCategoryTypeId: 'type',
    collectionId: 'collection',
    ownerId: 'owner',
    deletedAt: null,
    categoryId: 'category',
    categoryActive: true,
    categoryTypeId: 'type',
    categoryTypeActive: true,
    categoryTypeParentId: 'category',
  });
  const service: any = new StoreService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  it('validates joined taxonomy without reloading any delegates', async () => {
    await expect(
      service.assertProductTaxonomy({}, 'category', 'type', snapshot()),
    ).resolves.toBeUndefined();
  });

  const failures: Array<[Partial<BulkProductTaxonomy>, string]> = [
    [{ categoryId: null }, 'Category not found'],
    [{ categoryActive: false }, 'Category is not active'],
    [{ categoryTypeId: null }, 'Sub-category not found'],
    [{ categoryTypeActive: false }, 'Sub-category is not active'],
    [{ categoryTypeParentId: 'other' }, 'Sub-category does not belong'],
  ];
  it.each(failures)(
    'keeps canonical category errors for %p',
    async (patch, message) => {
      await expect(
        service.assertProductTaxonomy({}, 'category', 'type', {
          ...snapshot(),
          ...patch,
        }),
      ).rejects.toThrow(message);
    },
  );

  it('refuses accidentally reusing a snapshot for a different mutation', async () => {
    await expect(
      service.assertProductTaxonomy({}, 'other', 'type', snapshot()),
    ).rejects.toThrow('does not match this mutation');
  });

  it('does not let snapshot reuse bypass any of the remaining publish-readiness checks', async () => {
    const input = {
      name: 'Casual dress',
      description: 'Cotton',
      categoryId: 'category',
      categoryTypeId: 'type',
      gender: 'FEMALE',
      tags: ['casual'],
      price: 1000,
      images: ['front', 'left', 'right', 'back'],
      thumbnail: 'front',
      variants: Array.from({ length: 5 }, (_, index) => ({
        size: `S${index}`,
        stock: 1,
      })),
      totalStock: 5,
      trackInventory: true,
    };
    await expect(
      service.assertProductPublishReady({}, input, snapshot()),
    ).resolves.toBeUndefined();
    const invalid: Array<[Partial<typeof input>, string]> = [
      [{ images: ['front'] }, 'Upload at least'],
      [{ variants: [] }, 'size variants are required'],
      [{ price: 0 }, 'Price must be greater'],
      [{ tags: [] }, 'Add at least one hashtag'],
      [{ totalStock: 0 }, 'must have stock'],
      [{ thumbnail: 'other' }, 'one of the uploaded'],
    ];
    for (const [patch, message] of invalid)
      await expect(
        service.assertProductPublishReady(
          {},
          { ...input, ...patch },
          snapshot(),
        ),
      ).rejects.toThrow(message);
  });
});
