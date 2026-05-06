import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { StoreService } from './store.service';

describe('StoreService', () => {
  const originalStorePaymentAccountSecret = process.env.STORE_PAYMENT_ACCOUNT_SECRET;
  const originalVerificationDraftSecret = process.env.VERIFICATION_DRAFT_SECRET;

  const prisma = {
    brand: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    storePolicy: { findUnique: jest.fn() },
    storePaymentAccount: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  } as any;

  const service = new StoreService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STORE_PAYMENT_ACCOUNT_SECRET = 'store-secret';
    process.env.VERIFICATION_DRAFT_SECRET = 'legacy-store-secret';
  });

  afterEach(() => {
    process.env.STORE_PAYMENT_ACCOUNT_SECRET = originalStorePaymentAccountSecret;
    process.env.VERIFICATION_DRAFT_SECRET = originalVerificationDraftSecret;
  });

  it('coalesces supported bank list fetches while the first request is in flight', async () => {
    const callPaystackSpy = jest.spyOn(service as any, 'callPaystack');
    let resolveBanks: (value: any) => void = () => undefined;
    callPaystackSpy.mockReturnValue(
      new Promise((resolve) => {
        resolveBanks = resolve;
      }),
    );

    const first = service.listSupportedPaymentBanks();
    const second = service.listSupportedPaymentBanks();
    resolveBanks([
      { id: 1, code: '058', name: 'Bank A', active: true, currency: 'NGN', type: 'nuban' },
      { id: 2, code: '011', name: 'Bank B', active: true, currency: 'NGN', type: 'nuban' },
    ]);

    const [firstBanks, secondBanks] = await Promise.all([first, second]);

    expect(callPaystackSpy).toHaveBeenCalledTimes(1);
    expect(firstBanks).toEqual(secondBanks);
    expect(firstBanks).toHaveLength(2);
  });

  it('requires STORE_PAYMENT_ACCOUNT_SECRET for new payout-account encryption', () => {
    delete process.env.STORE_PAYMENT_ACCOUNT_SECRET;

    expect(() => (service as any).encryptStorePaymentValue('1234567890')).toThrow(
      BadRequestException,
    );
  });

  it('decrypts legacy payout-account values created with the fallback secret', () => {
    const iv = randomBytes(12);
    const legacyKey = createHash('sha256')
      .update(String(process.env.VERIFICATION_DRAFT_SECRET ?? '').trim())
      .digest();
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const encrypted = Buffer.concat([
      cipher.update('1234567890', 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const payload = `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;

    expect((service as any).decryptStorePaymentValue(payload)).toBe('1234567890');
  });

  it('keeps the last known good payout-account state when a sync attempt fails midway', async () => {
    jest.spyOn(service as any, 'resolveBrandByIdOrOwner').mockResolvedValue({
      id: 'brand_1',
      isStoreOpen: true,
      ownerId: 'owner_1',
    });
    jest.spyOn(service as any, 'listSupportedPaymentBanks').mockResolvedValue([
      { id: 1, code: '058', name: 'Bank A', currency: 'NGN' },
    ]);
    const callPaystackSpy = jest.spyOn(service as any, 'callPaystack');
    callPaystackSpy.mockImplementation((path: string, options?: { method?: string }) => {
      if (path.startsWith('/bank/resolve')) {
        return Promise.resolve({
          account_number: '1234567890',
          account_name: 'Ada Lovelace',
          bank_id: 1,
        });
      }

      if (path === '/subaccount' && options?.method === 'POST') {
        return Promise.resolve({
          id: 'sub_new',
          subaccount_code: 'SUB_NEW',
          active: true,
          is_verified: true,
        });
      }

      if (
        path === '/subaccount/SUB_OLD' &&
        options?.method === 'PUT'
      ) {
        return Promise.resolve({
          id: 'sub_old',
          subaccount_code: 'SUB_OLD',
          active: true,
          is_verified: true,
        });
      }

      if (
        path === '/transferrecipient/TRF_OLD' &&
        options?.method === 'GET'
      ) {
        return Promise.resolve({
          id: 'recipient_old_remote',
          recipient_code: 'TRF_OLD',
          active: true,
          details: { bank_code: '058', account_number: '1234567890' },
        });
      }

      if (
        path === '/transferrecipient/TRF_OLD' &&
        options?.method === 'PUT'
      ) {
        return Promise.reject(new Error('Transfer recipient update failed'));
      }

      if (
        path === '/transferrecipient' &&
        options?.method === 'POST'
      ) {
        return Promise.resolve({
          id: 'recipient_new',
          recipient_code: 'TRF_NEW',
          active: true,
        });
      }

      return Promise.reject(new Error(`Unexpected Paystack call: ${path}`));
    });

    const encryptedAccountNumber = (service as any).encryptStorePaymentValue('1234567890');
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1', name: 'Brand One' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'owner_1',
      email: 'owner@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phoneNumber: '08030000000',
      isEmailVerified: true,
    });
    prisma.storePaymentAccount.findUnique.mockResolvedValue({
      brandId: 'brand_1',
      status: 'ACTIVE',
      provider: 'PAYSTACK',
      countryCode: 'NG',
      currency: 'NGN',
      businessName: 'Brand One',
      primaryContactName: 'Old Contact',
      primaryContactEmail: 'old@example.com',
      primaryContactPhone: '08010000000',
      bankCode: '058',
      bankName: 'Bank A',
      accountName: 'Ada Lovelace',
      accountNumberEncrypted: encryptedAccountNumber,
      accountNumberLast4: '7890',
      isAccountResolved: true,
      accountResolvedAt: new Date('2026-03-01T00:00:00.000Z'),
      subaccountCode: 'SUB_OLD',
      subaccountId: 'sub_old',
      subaccountActive: true,
      subaccountVerified: true,
      subaccountLastSyncAt: new Date('2026-03-01T00:00:00.000Z'),
      transferRecipientCode: 'TRF_OLD',
      transferRecipientId: 'recipient_old',
      transferRecipientActive: true,
      transferRecipientLastSyncAt: new Date('2026-03-01T00:00:00.000Z'),
      lastSyncError: null,
      metadata: { lastSuccessfulSyncAt: '2026-03-01T00:00:00.000Z' },
    });
    prisma.storePaymentAccount.upsert.mockResolvedValue({});

    await expect(
      service.updateStorePaymentAccount('owner_1', {
        bankCode: '058',
        accountNumber: '1234567890',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    const upsertArgs = prisma.storePaymentAccount.upsert.mock.calls[0][0];
    expect(upsertArgs.create.status).toBe('SYNC_ERROR');
    expect(upsertArgs.update.status).toBe('SYNC_ERROR');
    expect(upsertArgs.create.subaccountCode).toBe('SUB_OLD');
    expect(upsertArgs.update.subaccountCode).toBe('SUB_OLD');
    expect(upsertArgs.create.transferRecipientCode).toBe('TRF_OLD');
    expect(upsertArgs.update.transferRecipientCode).toBe('TRF_OLD');
    expect(upsertArgs.create.lastSyncError).toBe('Transfer recipient update failed');
    expect(upsertArgs.update.lastSyncError).toBe('Transfer recipient update failed');
  });

  it('reports brand profile completeness separately from store setup completeness', async () => {
    prisma.brand.findUnique.mockResolvedValue({
      id: 'brand_1',
      name: 'Brand One',
      description: 'A valid store description for setup.',
      tags: ['fashion'],
      logo: null,
      banner: null,
      isStoreOpen: false,
      tagline: null,
      contactEmail: null,
      socialInstagram: null,
      socialTwitter: null,
      socialTiktok: null,
      socialWebsite: null,
      responseTimeSla: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'owner_1',
      isEmailVerified: true,
      brandDescription: 'Short bio',
      brandTags: [],
      brandCountry: null,
      brandState: null,
    });
    prisma.storePolicy.findUnique.mockResolvedValue({ responseTimeSla: '24h' });
    prisma.storePaymentAccount.findUnique.mockResolvedValue(null);

    const status = await service.getStoreStatus('owner_1');

    expect(status.isEmailVerified).toBe(true);
    expect(status.isProfileComplete).toBe(false);
    expect(status.profileMissingFields).toEqual(['location']);
    expect(status.isSetupComplete).toBe(false);
  });

  it('resolves catalog brand from an active brand membership', async () => {
    const brandAccess = {
      getPrimaryBrandContext: jest.fn().mockResolvedValue({
        activeBrandId: 'brand_1',
        memberships: [],
      }),
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const catalogPrisma = {
      brand: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'brand_1',
          ownerId: 'owner_1',
          currency: 'NGN',
        }),
      },
    } as any;
    const catalogService = new StoreService(
      catalogPrisma,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      brandAccess as any,
    );

    await expect(
      (catalogService as any).resolveCatalogBrandForActor('staff_1'),
    ).resolves.toEqual({
      id: 'brand_1',
      ownerId: 'owner_1',
      currency: 'NGN',
    });
    expect(brandAccess.assertCanManageCatalog).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      'catalog.write',
    );
  });

  it('allows an active catalog manager to manage an existing product', async () => {
    const brandAccess = {
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const catalogPrisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product_1',
          brandId: 'brand_1',
          brand: { id: 'brand_1', ownerId: 'owner_1' },
        }),
      },
    } as any;
    const catalogService = new StoreService(
      catalogPrisma,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      brandAccess as any,
    );

    await expect(
      (catalogService as any).assertBrandOwnsProduct(
        'catalog_manager_1',
        'product_1',
      ),
    ).resolves.toEqual({
      id: 'product_1',
      brandId: 'brand_1',
      brand: { id: 'brand_1', ownerId: 'owner_1' },
    });
    expect(brandAccess.assertCanManageCatalog).toHaveBeenCalledWith(
      'catalog_manager_1',
      'brand_1',
      'catalog.write',
    );
  });

  it('requires catalog.delete for product media deletion', async () => {
    const brandAccess = {
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const catalogPrisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product_1',
          brandId: 'brand_1',
          brand: { id: 'brand_1', ownerId: 'owner_1' },
          images: ['https://cdn.example.com/image.jpg'],
          thumbnail: 'https://cdn.example.com/image.jpg',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      fileUpload: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'media_1',
          s3Url: 'https://cdn.example.com/image.jpg',
          userId: 'catalog_manager_1',
        }),
      },
    } as any;
    const uploadService = {
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    const catalogService = new StoreService(
      catalogPrisma,
      {} as any,
      uploadService as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      brandAccess as any,
    );

    await expect(
      catalogService.deleteProductMedia(
        'catalog_manager_1',
        'product_1',
        'media_1',
      ),
    ).resolves.toEqual({ success: true });
    expect(brandAccess.assertCanManageCatalog).toHaveBeenCalledWith(
      'catalog_manager_1',
      'brand_1',
      'catalog.delete',
    );
  });

  it('rejects catalog brand resolution when the actor has no active brand', async () => {
    const brandAccess = {
      getPrimaryBrandContext: jest.fn().mockResolvedValue({
        activeBrandId: null,
        memberships: [],
      }),
      assertCanManageCatalog: jest.fn(),
    };
    const catalogService = new StoreService(
      { brand: { findUnique: jest.fn() } } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      brandAccess as any,
    );

    await expect(
      (catalogService as any).resolveCatalogBrandForActor('regular_1'),
    ).rejects.toThrow('active brand membership');
  });
});
