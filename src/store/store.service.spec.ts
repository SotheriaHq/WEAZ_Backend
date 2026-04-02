import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { StoreService } from './store.service';

describe('StoreService', () => {
  const originalStorePaymentAccountSecret = process.env.STORE_PAYMENT_ACCOUNT_SECRET;
  const originalVerificationDraftSecret = process.env.VERIFICATION_DRAFT_SECRET;

  const prisma = {
    brand: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
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
});