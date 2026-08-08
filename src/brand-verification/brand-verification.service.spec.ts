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
      update: jest.fn(),
    },
    fileUpload: {
      findFirst: jest.fn(),
    },
    userProfile: {
      updateMany: jest.fn(),
    },
    // Submission is gated on store readiness (`getStoreReadiness`), because an
    // approved verification produces no badge while the store is unpublished.
    storePaymentAccount: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  };

  /** A brand whose store is finished, so store readiness does not block submit. */
  const storeReadyBrand = {
    name: 'Ada Style',
    description: 'Ready-to-wear label',
    tags: ['fashion'],
    storePublishedAt: new Date('2026-05-01T00:00:00.000Z'),
    businessHoursConfiguredAt: new Date('2026-05-01T00:00:00.000Z'),
  };
  const notifications = { create: jest.fn() };
  const emailService = {
    getAppName: jest.fn(() => 'WIEZ'),
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

  it('writes verification identity fields to Brand and updates owner UserProfile phone only', async () => {
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
    prisma.brand.findUnique.mockResolvedValue(storeReadyBrand);
    prisma.storePaymentAccount.findUnique.mockResolvedValue({ status: 'ACTIVE' });
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
        }),
      }),
    );
    expect(prisma.userProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner-1' },
      data: { phoneNumber: '+2348030000000' },
    });
  });

  // The verified badge needs an APPROVED verification AND an open store, so a
  // brand that verifies before finishing setup earns an approval that shows no
  // badge — the admin sees success, the brand sees nothing change, and no screen
  // names the reason. Refuse the submission instead, naming what is left.
  it('refuses submission while store setup is incomplete and names the pending steps', async () => {
    prisma.brand.findFirst.mockResolvedValue({
      id: 'brand-1',
      name: 'Ada Style',
      ownerId: 'owner-1',
      verificationStatus: BrandVerificationStatus.NOT_SUBMITTED,
      verificationAttemptNumber: 0,
      verificationCooldownExpiresAt: null,
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
    // Unpublished store, no business hours, no verified payout account.
    prisma.brand.findUnique.mockResolvedValue({
      name: 'Ada Style',
      description: 'Ready-to-wear label',
      tags: ['fashion'],
      storePublishedAt: null,
      businessHoursConfiguredAt: null,
    });
    prisma.storePaymentAccount.findUnique.mockResolvedValue(null);

    await expect(
      service.submit('owner-1', {
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
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'STORE_SETUP_INCOMPLETE' }),
    });

    // Nothing may be written when the gate refuses.
    expect(prisma.brandVerificationAttempt.create).not.toHaveBeenCalled();

    const readiness = await service.getStoreReadiness('brand-1');
    expect(readiness.isReady).toBe(false);
    expect(readiness.pending.map((step) => step.code)).toEqual(
      expect.arrayContaining(['paymentAccount', 'businessHours', 'publish']),
    );
    // Every pending step must carry a route the client can link to.
    expect(readiness.pending.every((step) => Boolean(step.href))).toBe(true);
  });

  it('fails production draft encryption when the secret is missing or legacy', () => {
    const missing = new BrandVerificationService(
      prisma,
      {} as any,
      notifications as any,
      emailService as any,
      {
        get: jest.fn((key: string) =>
          key === 'NODE_ENV' ? 'production' : undefined,
        ),
      } as any,
    );
    expect(() => (missing as any).encryptDraft({ currentStep: 1 })).toThrow(
      'Verification draft encryption is not configured',
    );

    const legacy = new BrandVerificationService(
      prisma,
      {} as any,
      notifications as any,
      emailService as any,
      {
        get: jest.fn((key: string) => {
          if (key === 'NODE_ENV') return 'production';
          if (key === 'VERIFICATION_DRAFT_SECRET') {
            return 'wiez-verification-draft-secret';
          }
          return undefined;
        }),
      } as any,
    );
    expect(() => (legacy as any).encryptDraft({ currentStep: 1 })).toThrow(
      'Verification draft encryption secret is unsafe',
    );
  });

  it('keeps development draft encryption usable without the production fallback secret', () => {
    const target = new BrandVerificationService(
      prisma,
      {} as any,
      notifications as any,
      emailService as any,
      {
        get: jest.fn((key: string) =>
          key === 'NODE_ENV' ? 'test' : undefined,
        ),
      } as any,
    );

    const encrypted = (target as any).encryptDraft({ currentStep: 2 });

    expect((target as any).decryptDraft(encrypted)).toEqual({ currentStep: 2 });
    expect(encrypted).not.toContain('wiez-verification-draft-secret');
  });

  describe('getDraft', () => {
    const brandWithoutDraft = (
      verificationStatus: BrandVerificationStatus,
    ) => ({
      id: 'brand-1',
      name: 'Ada Style',
      ownerId: 'owner-1',
      verificationStatus,
      // `submit` nulls both of these, which is the whole reason the wizard
      // came up blank on the way back in.
      verificationDraftData: null,
      verificationDraftUpdatedAt: null,
      owner: {
        id: 'owner-1',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Okafor',
        status: 'ACTIVE',
        deactivatedAt: null,
      },
    });

    const filedAttempt = {
      id: 'attempt-1',
      brandId: 'brand-1',
      attemptNumber: 1,
      status: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
      submittedAt: new Date('2026-08-01T09:00:00.000Z'),
      updatedAt: new Date('2026-08-02T09:00:00.000Z'),
      ownerLegalFirstName: 'Ada',
      ownerLegalLastName: 'Okafor',
      ownerDateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      ownerGender: VerificationOwnerGender.FEMALE,
      ownerPhoneNumber: '+2348030000000',
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
      idDocumentExpiryDate: new Date('2030-06-30T00:00:00.000Z'),
      legalEntityType: VerificationLegalEntityType.LIMITED_COMPANY,
      authorityType: VerificationAuthorityType.LEGAL_OWNER,
      authorityProofDescription: null,
      ownerPhotoKey: 'owner-photo',
      idDocumentFrontKey: 'id-front',
      idDocumentBackKey: 'id-back',
      cacCertificateKey: 'cac-cert',
      authorityProofKey: null,
      letterOfConfirmationKey: 'letter-key',
    };

    it('rehydrates the wizard from the last attempt after an admin asks for more information', async () => {
      // The reported bug: admin requests extra info, the brand clicks
      // "Continue with corrections", and the form is completely empty because
      // `submit` already nulled the draft. The owner then had to retype every
      // legal detail and re-upload every document — and the submit DTO
      // requires all of them, so partial compliance was impossible.
      prisma.brand.findFirst.mockResolvedValue(
        brandWithoutDraft(BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED),
      );
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue(filedAttempt);

      const result = await service.getDraft('owner-1');

      expect(result.source).toBe('LAST_ATTEMPT');
      expect(result.draftData).toEqual(
        expect.objectContaining({
          ownerLegalFirstName: 'Ada',
          ownerLegalLastName: 'Okafor',
          ownerNin: '12345678901',
          cacNumber: 'CAC12345',
          idDocumentNumber: 'NIN-123',
          businessAddress: {
            street: '12 Market Road',
            city: 'Ikeja',
            state: 'Lagos',
            country: 'Nigeria',
          },
          // Renamed on the way out: the client field is `letterKey`.
          letterKey: 'letter-key',
          // Evidence keys must survive too, or "prefilled" still means
          // re-uploading five documents.
          ownerPhotoKey: 'owner-photo',
          idDocumentFrontKey: 'id-front',
          idDocumentBackKey: 'id-back',
          cacCertificateKey: 'cac-cert',
        }),
      );
    });

    it('narrows dates to the YYYY-MM-DD that date inputs accept', async () => {
      // A full ISO string is rejected by <input type="date"> and renders as an
      // empty field, which would look exactly like the bug being fixed.
      prisma.brand.findFirst.mockResolvedValue(
        brandWithoutDraft(BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED),
      );
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue(filedAttempt);

      const draft = (await service.getDraft('owner-1')).draftData as Record<
        string,
        unknown
      >;

      expect(draft.ownerDateOfBirth).toBe('1990-01-01');
      expect(draft.idDocumentExpiryDate).toBe('2030-06-30');
    });

    it('omits enum fields the attempt never captured so client defaults survive', async () => {
      // The client merges with `{ ...current, ...draft }`, so an explicit
      // `undefined` would erase its own defaults and blank the dropdowns.
      prisma.brand.findFirst.mockResolvedValue(
        brandWithoutDraft(BrandVerificationStatus.REJECTED),
      );
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue({
        ...filedAttempt,
        ownerGender: null,
        idDocumentType: null,
        legalEntityType: null,
        authorityType: null,
      });

      const draft = (await service.getDraft('owner-1')).draftData as Record<
        string,
        unknown
      >;

      expect(draft).not.toHaveProperty('ownerGender');
      expect(draft).not.toHaveProperty('idDocumentType');
      expect(draft).not.toHaveProperty('legalEntityType');
      expect(draft).not.toHaveProperty('authorityType');
    });

    it('prefers a live saved draft over the last attempt', async () => {
      // An in-progress draft is newer than any filed attempt. Rehydration is a
      // fallback, never an overwrite.
      const target = new BrandVerificationService(
        prisma,
        {} as any,
        notifications as any,
        emailService as any,
        { get: jest.fn((key: string) => (key === 'NODE_ENV' ? 'test' : undefined)) } as any,
      );
      const savedAt = new Date('2026-08-05T10:00:00.000Z');
      prisma.brand.findFirst.mockResolvedValue({
        ...brandWithoutDraft(BrandVerificationStatus.NOT_SUBMITTED),
        verificationDraftData: (target as any).encryptDraft({
          ownerLegalFirstName: 'Half',
          currentStep: 2,
        }),
        verificationDraftUpdatedAt: savedAt,
      });
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue(filedAttempt);

      const result = await target.getDraft('owner-1');

      expect(result.source).toBe('DRAFT');
      expect(result.draftData).toEqual({
        ownerLegalFirstName: 'Half',
        currentStep: 2,
      });
      expect(result.lastSavedAt).toBe(savedAt);
      expect(prisma.brandVerificationAttempt.findFirst).not.toHaveBeenCalled();
    });

    it('rehydrates after a rejection too, so corrections do not start from zero', async () => {
      prisma.brand.findFirst.mockResolvedValue(
        brandWithoutDraft(BrandVerificationStatus.REJECTED),
      );
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue({
        ...filedAttempt,
        status: BrandVerificationStatus.REJECTED,
      });

      const result = await service.getDraft('owner-1');

      expect(result.source).toBe('LAST_ATTEMPT');
      expect(
        (result.draftData as Record<string, unknown>).ownerLegalFirstName,
      ).toBe('Ada');
    });

    it('returns an empty draft for a brand that has never submitted', async () => {
      prisma.brand.findFirst.mockResolvedValue(
        brandWithoutDraft(BrandVerificationStatus.NOT_SUBMITTED),
      );
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue(null);

      const result = await service.getDraft('owner-1');

      expect(result).toEqual({
        draftData: null,
        lastSavedAt: null,
        source: 'EMPTY',
      });
    });
  });

  describe('resubmitInfo', () => {
    it('maps letterKey onto its attempt column instead of handing the client name to Prisma', async () => {
      // The wizard sends `letterKey` on every submission, but the attempt
      // column is `letterOfConfirmationKey`. The blind `Object.entries(dto)`
      // patch passed the client name through, so Prisma rejected the update
      // with `Unknown argument 'letterKey'` and answering an admin's request
      // for more information failed every single time.
      prisma.brand.findFirst.mockResolvedValue({
        id: 'brand-1',
        name: 'Ada Style',
        ownerId: 'owner-1',
        verificationStatus: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
        verificationReviewedById: null,
        owner: {
          id: 'owner-1',
          email: 'ada@example.com',
          firstName: 'Ada',
          lastName: 'Okafor',
          status: 'ACTIVE',
          deactivatedAt: null,
        },
      });
      prisma.brandVerificationAttempt.findFirst.mockResolvedValue({
        id: 'attempt-1',
      });
      prisma.brandVerificationAttempt.update.mockResolvedValue({});
      prisma.brand.update.mockResolvedValue({});

      await service.resubmitInfo('owner-1', {
        letterKey: 'new-letter-key',
        ownerPhoneNumber: '08030000000',
        idDocumentExpiryDate: '2031-01-31',
      });

      const data =
        prisma.brandVerificationAttempt.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('letterKey');
      expect(data.letterOfConfirmationKey).toBe('new-letter-key');
      // Same E.164 form the brand and profile records get.
      expect(data.ownerPhoneNumber).toBe('+2348030000000');
      expect(data.idDocumentExpiryDate).toEqual(new Date('2031-01-31'));
      expect(data.status).toBe(BrandVerificationStatus.IN_REVIEW);
    });
  });
});
