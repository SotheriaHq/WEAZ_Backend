import { CollectionsService } from './collections.service';

const product = (publicationStatus = 'PUBLISHED') => ({
  id: publicationStatus,
  name: publicationStatus === 'PUBLISHED' ? 'Public piece' : 'Private piece',
  publicationStatus,
  isActive: true,
  price: 10000,
  thumbnail: null,
  images: [`https://media.example/${publicationStatus}.webp`],
  totalStock: 1,
  customOrderEnabled: false,
  deletedAt: null,
  archivedAt: null,
  publishAt: null,
  collections: [],
  brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
});

function fixture() {
  const collection = {
    id: 'collection',
    ownerId: 'owner',
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
    products: [
      { product: product() },
      { product: { ...product('DRAFT'), costPerItem: 4000 } },
    ],
    _count: { products: 2 },
  };
  const prisma = {
    storeCollection: {
      findFirst: jest.fn().mockResolvedValue(collection),
      findMany: jest.fn().mockResolvedValue([collection]),
    },
  };
  const service = Object.create(CollectionsService.prototype) as any;
  service.prisma = prisma;
  service.uploadService = {
    getBatchAuthorizedDisplayUrls: jest.fn().mockResolvedValue(new Map()),
  };
  jest.spyOn(service, 'canViewStoreCollection').mockResolvedValue(true);
  jest.spyOn(service, 'mapCollectionOwner').mockReturnValue(null);
  return { collection, prisma, service };
}

describe('public Store Collection eligibility', () => {
  it.each(['PRIVATE', undefined])(
    "does not reveal a linked product's published collection ID with visibility %s",
    (visibility) => {
      const { service } = fixture();
      const link = {
        product: {
          ...product(),
          collectionId: 'hidden-capsule-id',
          collections: [
            {
              collectionId: 'hidden-capsule-id',
              collection: {
                status: 'PUBLISHED',
                visibility,
                isAvailableInStore: true,
                deletedAt: null,
              },
            },
          ],
        },
      };
      const view = service.storeCollectionProductProjection(link, false);
      expect(view.product.collectionId).toBeNull();
      expect(JSON.stringify(view)).not.toContain('hidden-capsule-id');
      expect(
        service.storeCollectionProductProjection(link, true).product
          .collectionId,
      ).toBe('hidden-capsule-id');
    },
  );

  it.each(['', '   '])(
    'uses valid later images instead of thumbnail %j for detail and public list covers',
    async (thumbnail) => {
      const { service, collection } = fixture();
      collection.products = [
        {
          product: {
            ...product(),
            thumbnail,
            images: ['', '  ', 'https://media.example/visible.webp'],
          },
        },
      ];
      const detail = await service.getStoreCollection('collection', 'shopper');
      const list = await service.listPublicStoreCollections();
      expect(detail.coverImageUrl).toBe('https://media.example/visible.webp');
      expect(list.items[0].coverImage).toBe(
        'https://media.example/visible.webp',
      );
    },
  );

  it('also protects commerce products linked to a public design detail', async () => {
    const { service, collection } = fixture();
    service.prisma.collection = {
      findUnique: jest.fn().mockResolvedValue({
        ...collection,
        domain: 'DESIGN',
        medias: [],
        threadsCount: 0,
        collectionCollabsCount: 0,
      }),
    };
    service.prisma.collectionMedia = {
      aggregate: jest.fn().mockResolvedValue({ _sum: { threadsCount: 0 } }),
    };
    jest.spyOn(service, 'canViewCollection').mockResolvedValue(true);
    jest.spyOn(service, 'filterViewableCollectionMedias').mockReturnValue([]);
    const result = await service.getCollection('collection', 'shopper');
    expect(result.products.map((link: any) => link.product.id)).toEqual([
      'PUBLISHED',
    ]);
    expect(JSON.stringify(result)).not.toContain('Private piece');
    expect(JSON.stringify(result)).not.toContain('DRAFT.webp');
  });

  it.each([undefined, 'shopper'])(
    'detail never exposes a nested draft to requester %s',
    async (requester) => {
      const { service, prisma } = fixture();
      const result = await service.getStoreCollection('collection', requester);
      expect(result.products.map((link: any) => link.product.id)).toEqual([
        'PUBLISHED',
      ]);
      expect(JSON.stringify(result)).not.toContain('Private piece');
      expect(JSON.stringify(result)).not.toContain('DRAFT.webp');
      expect(result.products[0].product.brand).toBeUndefined();
      expect(
        prisma.storeCollection.findFirst.mock.calls[0][0].where.OR,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            products: expect.any(Object),
            owner: { status: 'ACTIVE', brand: { isStoreOpen: true } },
          }),
        ]),
      );
    },
  );

  it('keeps the owner draft-preview behavior', async () => {
    const { service } = fixture();
    const result = await service.getStoreCollection('collection', 'owner');
    expect(result.products).toHaveLength(2);
  });

  it('public lists count and return eligible children only', async () => {
    const { service } = fixture();
    const result = await service.listPublicStoreCollections();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].productCount).toBe(1);
    expect(result.items[0].products[0].product.brand).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Private piece');
  });

  it('nonowner profile lists cannot leak draft product preview media', async () => {
    const { service } = fixture();
    const result = await service.getUserStoreCollections('owner', 'shopper');
    expect(result.items[0].itemCount).toBe(1);
    expect(result.items[0]._count.products).toBe(1);
    expect(JSON.stringify(result)).not.toContain('DRAFT.webp');
  });
});
