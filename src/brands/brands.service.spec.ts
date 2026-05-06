import { Test, TestingModule } from '@nestjs/testing';
import { BrandsService } from './brands.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BadRequestException } from '@nestjs/common';
import { PatchStatus, UserType } from '@prisma/client';
import { SystemTagsService } from '../tags/system-tags.service';
import { TagIndexService } from '../tags/tag-index.service';

describe('BrandsService', () => {
  let service: BrandsService;

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
    mockPrisma.$transaction.mockImplementation((callback) => callback(mockPrisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: UploadService, useValue: {} },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: SystemTagsService, useValue: { syncTags: jest.fn() } },
        { provide: TagIndexService, useValue: { syncEntityTags: jest.fn() } },
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
    it('writes Brand canonical fields and dual-writes legacy User fields', async () => {
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
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'owner-1' },
          data: expect.objectContaining({
            brandFullName: 'Canonical Name',
            brandDescription: 'Canonical description',
            brandCountry: 'Nigeria',
            brandTags: ['ankara'],
            brandBusinessType: 'Atelier',
          }),
        }),
      );
      expect(response.brandFullName).toBe('Canonical Name');
      expect(response.brandTags).toEqual(['ankara']);
    });
  });
});
