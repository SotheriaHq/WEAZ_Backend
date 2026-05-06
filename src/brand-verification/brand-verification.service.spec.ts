import {
  BrandVerificationStatus,
  VerificationAuthorityType,
  VerificationIdDocumentType,
  VerificationLegalEntityType,
  VerificationOwnerGender,
} from '@prisma/client';
import { BrandVerificationService } from './brand-verification.service';

describe('BrandVerificationService', () => {
  const prisma: any = {
    brand: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    brandVerificationAttempt: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    fileUpload: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  };
  const notifications = { create: jest.fn() };
  const emailService = {
    getAppName: jest.fn(() => 'Threadly'),
    send: jest.fn(),
  };

  const service = new BrandVerificationService(
    prisma,
    {} as any,
    notifications as any,
    emailService as any,
    { get: jest.fn() } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback: any) => callback(prisma));
  });

  it('writes verification identity fields to Brand and dual-writes legacy User fields', async () => {
    prisma.brand.findFirst.mockResolvedValue({
      id: 'brand-1',
      name: 'Ada Style',
      ownerId: 'owner-1',
      verificationStatus: BrandVerificationStatus.NOT_SUBMITTED,
      verificationAttemptNumber: 0,
      verificationCooldownExpiresAt: null,
      verificationLetterHash: 'letter-hash',
      verificationLetterVersion: 1,
      owner: {
        id: 'owner-1',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Okafor',
        phoneNumber: '08030000000',
        status: 'ACTIVE',
        deactivatedAt: null,
      },
    });
    prisma.brandVerificationAttempt.findFirst.mockResolvedValue(null);
    prisma.fileUpload.findFirst.mockResolvedValue({
      id: 'file-1',
      s3Key: 'key',
      mimeType: 'image/jpeg',
      size: 100,
      sha256: null,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      fileType: 'BRAND_VERIFICATION',
    });
    prisma.brandVerificationAttempt.create.mockResolvedValue({});
    prisma.brand.update.mockResolvedValue({});
    notifications.create.mockResolvedValue({});
    emailService.send.mockResolvedValue({});

    await service.submit('owner-1', {
      ownerLegalFirstName: 'Ada',
      ownerLegalLastName: 'Okafor',
      ownerDateOfBirth: '1990-01-01',
      ownerGender: VerificationOwnerGender.FEMALE,
      ownerPhoneNumber: '08030000000',
      ownerNin: '12345678901',
      cacNumber: 'CAC12345',
      businessAddress: {
        street: '12 Market Road',
        city: 'Ikeja',
        state: 'Lagos',
        country: 'Nigeria',
      },
      idDocumentType: VerificationIdDocumentType.NIN_SLIP,
      idDocumentNumber: 'NIN-123',
      legalEntityType: VerificationLegalEntityType.LIMITED_COMPANY,
      authorityType: VerificationAuthorityType.LEGAL_OWNER,
      ownerPhotoKey: 'owner-photo',
      idDocumentFrontKey: 'id-front',
      idDocumentBackKey: 'id-back',
      cacCertificateKey: 'cac-cert',
      letterKey: 'letter-key',
    });

    expect(prisma.brand.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'brand-1' },
        data: expect.objectContaining({
          cacNumber: 'CAC12345',
          ceoNin: '12345678901',
          ceoFirstName: 'Ada',
          ceoLastName: 'Okafor',
          companyLocation: '12 Market Road, Ikeja, Lagos, Nigeria',
          country: 'Nigeria',
          state: 'Lagos',
          city: 'Ikeja',
          owner: {
            update: expect.objectContaining({
              cacNumber: 'CAC12345',
              ceoNin: '12345678901',
              ceoFirstName: 'Ada',
              ceoLastName: 'Okafor',
              companyLocation: '12 Market Road, Ikeja, Lagos, Nigeria',
              brandCountry: 'Nigeria',
              brandState: 'Lagos',
              brandCity: 'Ikeja',
            }),
          },
        }),
      }),
    );
  });
});
