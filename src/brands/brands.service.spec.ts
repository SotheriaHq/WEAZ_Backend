import { Test, TestingModule } from '@nestjs/testing';
import { BrandsService } from './brands.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PatchStatus, UserType } from '@prisma/client';

describe('BrandsService', () => {
    let service: BrandsService;
    let prisma: PrismaService;

    const mockPrisma = {
        user: {
            findUnique: jest.fn(),
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
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BrandsService,
                { provide: PrismaService, useValue: mockPrisma },
                { provide: UploadService, useValue: {} },
                { provide: NotificationsService, useValue: { create: jest.fn() } },
            ],
        }).compile();

        service = module.get<BrandsService>(BrandsService);
        prisma = module.get<PrismaService>(PrismaService);
    });

    describe('requestBrandPatch', () => {
        const requesterId = 'requester-id';
        const receiverId = 'receiver-id';

        it('should throw if requester has less than 3 collections', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ id: requesterId, type: UserType.BRAND });
            mockPrisma.collection.count.mockResolvedValue(2);

            await expect(service.requestBrandPatch(requesterId, receiverId))
                .rejects.toThrow(BadRequestException);
        });

        it('should throw if rate limit exceeded (3 requests in 30 days)', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ id: requesterId, type: UserType.BRAND });
            mockPrisma.collection.count.mockResolvedValue(5);
            mockPrisma.brandPatch.count.mockResolvedValue(3); // 3 recent requests

            await expect(service.requestBrandPatch(requesterId, receiverId))
                .rejects.toThrow('limit of 3 patch requests');
        });

        it('should throw if cooldown active (< 72h)', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ id: requesterId, type: UserType.BRAND });
            mockPrisma.collection.count.mockResolvedValue(5);
            mockPrisma.brandPatch.count.mockResolvedValue(0);

            const oneHourAgo = new Date();
            oneHourAgo.setHours(oneHourAgo.getHours() - 1);

            mockPrisma.brandPatch.findUnique.mockResolvedValue({
                id: 'patch-id',
                status: PatchStatus.REJECTED,
                updatedAt: oneHourAgo,
            });

            await expect(service.requestBrandPatch(requesterId, receiverId))
                .rejects.toThrow('Patch request rejected recently');
        });

        it('should allow request if cooldown passed (> 72h)', async () => {
            mockPrisma.user.findUnique.mockResolvedValue({ id: requesterId, type: UserType.BRAND });
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
                })
            );
        });
    });
});
