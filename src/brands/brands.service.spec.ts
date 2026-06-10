import { Test, TestingModule } from '@nestjs/testing';
import { BrandsService } from './brands.service';
import { BrandMetricsService } from './brand-metrics.service';
import { BrandProfileLinkService } from './brand-profile-link.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BadRequestException } from '@nestjs/common';
import { PatchStatus, UserType } from '@prisma/client';
import { SystemTagsService } from '../tags/system-tags.service';
import { TagIndexService } from '../tags/tag-index.service';
import { ProfilePhotoViewService } from '../users/profile-photo-view.service';

describe('BrandsService', () => {
  let service: BrandsService;
  const mockBrandProfileLinks = {
    getBrandProfileLinks: jest.fn(() => ({
      publicProfileUrl: 'https://threadly.test/u/maison',
      qrTargetUrl: 'https://threadly.test/u/maison',
      shareUrl: 'https://threadly.test/u/maison',
    })),
  };
  const mockProfilePhotoViewService = {
    getViewStateForOwner: jest.fn((owner) => ({
      ownerId: owner.id,
      profilePhotoUpdatedAt: null,
      viewed: true,
      hasUnviewedUpdate: false,
      canMarkViewed: false,
    })),
  };

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    brand: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    collection: {
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    collectionMedia: {
      aggregate: jest.fn(),
    },
    product: {
      count: jest.fn(),
    },
    patchConnection: {
      count: jest.fn(),
    },
    brandPatch: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((callback) =>
      callback(mockPrisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandsService,
        BrandMetricsService,
        { provide: BrandProfileLinkService, useValue: mockBrandProfileLinks },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: UploadService, useValue: {} },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: SystemTagsService, useValue: { syncTags: jest.fn() } },
        { provide: TagIndexService, useValue: { syncEntityTags: jest.fn() } },
        { provide: ProfilePhotoViewService, useValue: mockProfilePhotoViewService },
      ],
    }).compile();

    service = module.get<BrandsService>(BrandsService);
  });

  describe('requestBrandPatch', () => {
    const requesterId = 'requester-id';
    const receiverId = 'receiver-id';

    it('should throw if requester has less than 3 collections', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: requesterId,
        type: UserType.BRAND,
      });
      mockPrisma.collection.count.mockResolvedValue(2);

      await expect(
        service.requestBrandPatch(requesterId, receiverId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if rate limit exceeded (3 requests in 30 days)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: requesterId,
        type: UserType.BRAND,
      });
      mockPrisma.collection.count.mockResolvedValue(5);
      mockPrisma.brandPatch.count.mockResolvedValue(3); // 3 recent requests

      await expect(
        service.requestBrandPatch(requesterId, receiverId),
      ).rejects.toThrow('limit of 3 patch requests');
    });

    it('should throw if cooldown active (< 72h)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: requesterId,
        type: UserType.BRAND,
      });
      mockPrisma.collection.count.mockResolvedValue(5);
      mockPrisma.brandPatch.count.mockResolvedValue(0);

      const oneHourAgo = new Date();
      oneHourAgo.setHours(oneHourAgo.getHours() - 1);

      mockPrisma.brandPatch.findUnique.mockResolvedValue({
        id: 'patch-id',
        status: PatchStatus.REJECTED,
        updatedAt: oneHourAgo,
      });

      await expect(
        service.requestBrandPatch(requesterId, receiverId),
      ).rejects.toThrow('Patch request rejected recently');
    });

    it('should allow request if cooldown passed (> 72h)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: requesterId,
        type: UserType.BRAND,
      });
      mockPrisma.collection.count.mockResolvedValue(5);
      mockPrisma.brandPatch.count.mockResolvedValue(0);

      const fourDaysAgo = new Date();
      fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);

      mockPrisma.brandPatch.findUnique.mockResolvedValue({
        id: 'patch-id',
        status: PatchStatus.REJECTED,
        updatedAt: fourDaysAgo,
      });

      await service.requestBrandPatch(requesterId, receiverId);
      expect(mockPrisma.brandPatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'patch-id' },
          data: expect.objectContaining({ status: PatchStatus.PENDING }),
        }),
      );
    });
  });

  describe('updateBrandProfile', () => {
    it('writes Brand canonical fields without dual-writing legacy User fields', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({
          id: 'owner-1',
          username: 'brand-owner',
          firstName: 'Ada',
          lastName: 'Okafor',
          email: 'ada@example.com',
          phoneNumber: null,
          address: null,
          brandFullName: 'Legacy Name',
          brandDescription: null,
          brandCountry: null,
          brandState: null,
          brandCity: null,
          brandTags: [],
          brandBusinessType: null,
          socialInstagram: null,
          socialFacebook: null,
          socialTwitter: null,
          socialWebsite: null,
          companyLocation: null,
          industriNumber: 'IND-1',
          profileImage: null,
          profileImageFile: null,
          bannerImage: null,
          bannerImageId: null,
          bannerImageFile: null,
          cacNumber: null,
          tin: null,
          isEmailVerified: true,
          status: 'ACTIVE',
          deactivatedAt: null,
          createdAt: new Date('2026-05-05T00:00:00.000Z'),
          updatedAt: new Date('2026-05-05T00:00:00.000Z'),
          type: UserType.BRAND,
          brand: {
            id: 'brand-1',
            name: 'Legacy Name',
            tags: [],
            isStoreOpen: false,
            verificationStatus: 'NOT_SUBMITTED',
            avgRating: 0,
            totalReviews: 0,
          },
        })
        .mockResolvedValueOnce({
          id: 'owner-1',
          username: 'brand-owner',
          role: 'User',
          type: UserType.BRAND,
          firstName: 'Ada',
          lastName: 'Okafor',
          email: 'ada@example.com',
          status: 'ACTIVE',
          brand: {
            id: 'brand-1',
            name: 'Canonical Name',
            description: 'Canonical description',
            tags: ['ankara'],
            country: 'Nigeria',
            state: 'Lagos',
            city: 'Ikeja',
            businessType: 'Atelier',
            socialInstagram: 'https://instagram.com/canonical',
            socialFacebook: null,
            socialTwitter: null,
            socialWebsite: null,
            isStoreOpen: false,
            verificationStatus: 'NOT_SUBMITTED',
          },
          adminPermissionGrants: [],
          phoneNumber: null,
          address: null,
          brandFullName: 'Canonical Name',
          brandDescription: 'Canonical description',
          brandCountry: 'Nigeria',
          brandState: 'Lagos',
          brandCity: 'Ikeja',
          brandTags: ['ankara'],
          brandBusinessType: 'Atelier',
          socialInstagram: 'https://instagram.com/canonical',
          socialFacebook: null,
          socialTwitter: null,
          socialWebsite: null,
          cacNumber: null,
          tin: null,
          ceoNin: null,
          ceoFirstName: null,
          ceoLastName: null,
          companyLocation: 'Ikeja, Lagos, Nigeria',
          profileImage: null,
          profileImageId: null,
          bannerImage: null,
          bannerImageId: null,
          isEmailVerified: true,
          isActive: 'Active',
          themePreference: 'system',
          mustResetPassword: false,
          authVersion: 0,
          createdAt: new Date('2026-05-05T00:00:00.000Z'),
          updatedAt: new Date('2026-05-05T00:00:00.000Z'),
          userProfile: null,
        });
      mockPrisma.brand.upsert.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      const response = await service.updateBrandProfile('owner-1', {
        brandFullName: 'Canonical Name',
        brandDescription: 'Canonical description',
        brandCountry: 'Nigeria',
        brandState: 'Lagos',
        brandCity: 'Ikeja',
        brandTags: ['ankara'],
        businessType: 'Atelier',
        socialInstagram: 'https://instagram.com/canonical',
      });

      expect(mockPrisma.brand.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerId: 'owner-1' },
          update: expect.objectContaining({
            name: 'Canonical Name',
            description: 'Canonical description',
            country: 'Nigeria',
            tags: ['ankara'],
            businessType: 'Atelier',
          }),
        }),
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(response.brandFullName).toBe('Canonical Name');
      expect(response.brandTags).toEqual(['ankara']);
    });
  });

  describe('getBrandProfile', () => {
    it('returns canonical profile banner media over stale legacy brand banner', async () => {
      const createdAt = new Date('2026-05-01T00:00:00.000Z');
      const updatedAt = new Date('2026-05-02T00:00:00.000Z');
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'owner-1',
        username: 'maison',
        email: 'owner@example.com',
        isEmailVerified: true,
        status: 'ACTIVE',
        deactivatedAt: null,
        createdAt,
        updatedAt,
        type: UserType.BRAND,
        userProfile: {
          firstName: 'Maison',
          lastName: 'Vant',
          phoneNumber: null,
          address: null,
          profileImage: 'https://cdn.example.com/logo.jpg',
          profileImageId: 'logo-file-id',
          profileImageFile: {
            id: 'logo-file-id',
            s3Url: 's3://logo.jpg',
            fileName: 'logo.jpg',
            originalName: 'logo-original.jpg',
            createdAt,
            updatedAt,
          },
          bannerImage: 'https://cdn.example.com/banner.jpg',
          bannerImageId: 'banner-file-id',
          bannerImageFile: {
            id: 'banner-file-id',
            s3Url: 's3://banner.jpg',
            fileName: 'banner.jpg',
            originalName: 'banner-original.jpg',
            createdAt,
            updatedAt,
          },
        },
        brand: {
          id: 'brand-1',
          name: 'Maison Vant',
          description: 'Luxury menswear.',
          logo: 'https://cdn.example.com/brand-logo.jpg',
          banner: 'https://cdn.example.com/brand-banner.jpg',
          tags: ['menswear', 'minimalist'],
          country: 'USA',
          state: 'New York',
          city: 'New York',
          businessType: 'Atelier',
          companyLocation: null,
          socialInstagram: null,
          socialFacebook: null,
          socialTwitter: null,
          socialWebsite: null,
          cacNumber: null,
          tin: null,
          ceoNin: null,
          ceoFirstName: null,
          ceoLastName: null,
          industriNumber: null,
          isStoreOpen: true,
          verificationStatus: 'APPROVED',
          avgRating: 4.8,
          totalReviews: 12,
        },
      });
      mockPrisma.collection.count.mockResolvedValue(3);
      mockPrisma.product.count.mockResolvedValue(7);
      mockPrisma.patchConnection.count.mockResolvedValue(42);
      mockPrisma.collection.aggregate.mockResolvedValue({
        _sum: { threadsCount: 10 },
      });
      mockPrisma.collectionMedia.aggregate.mockResolvedValue({
        _sum: { threadsCount: 15 },
      });

      const response = await service.getBrandProfile('brand-1');

      expect(mockPrisma.collection.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          ownerId: 'owner-1',
          status: 'PUBLISHED',
          visibility: 'PUBLIC',
          deletedAt: null,
        }),
      });
      expect(mockPrisma.collectionMedia.aggregate).toHaveBeenCalledWith({
        where: {
          collection: expect.objectContaining({
            ownerId: 'owner-1',
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            deletedAt: null,
          }),
        },
        _sum: { threadsCount: true },
      });
      expect(response.logoImage).toBe('https://cdn.example.com/brand-logo.jpg');
      expect(response.logoImageId).toBe('logo-file-id');
      expect(response.bannerImage).toBe('https://cdn.example.com/banner.jpg');
      expect(response.bannerImageId).toBe('banner-file-id');
      expect(response.bannerImageMeta).toEqual(
        expect.objectContaining({
          fileId: 'banner-file-id',
          url: 's3://banner.jpg',
        }),
      );
      expect(response.followersCount).toBe(42);
      expect(response.totalThreads).toBe(25);
      expect(response.totalLikes).toBe(25);
      expect(response.designsCount).toBe(3);
      expect(response.productsCount).toBe(7);
      expect(response.storeStatus).toBe('OPEN');
      expect(response.emailVerified).toBe(true);
      expect(response.totalShares).toBeNull();
      expect(mockBrandProfileLinks.getBrandProfileLinks).toHaveBeenCalledWith({
        ownerId: 'owner-1',
        username: 'maison',
      });
      expect(response.publicProfileUrl).toBe('https://threadly.test/u/maison');
      expect(response.qrTargetUrl).toBe('https://threadly.test/u/maison');
      expect(response.shareUrl).toBe('https://threadly.test/u/maison');
    });
  });
});
