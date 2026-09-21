import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PayoutService } from './payout.service';
import { PrismaService } from '../prisma/prisma.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { CommissionService } from 'src/finance/commission.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { PasswordService } from 'src/auth/helper/password.service';
import { EmailService } from 'src/email/email.service';

const BRAND_ID = 'brand-1';
const USER_ID = 'user-1';

describe('PayoutService', () => {
  let service: PayoutService;
  let prisma: any;
  let emailService: { send: jest.Mock; getAppName: jest.Mock };
  let passwordService: { hashPassword: jest.Mock; verifyPassword: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      brand: { findUnique: jest.fn() },
      emailLoginCode: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      payout: { create: jest.fn() },
      $queryRaw: jest.fn(),
      // Run the callback against the same mock; every write in these flows is
      // asserted directly rather than through a real transaction.
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };

    emailService = {
      send: jest.fn().mockResolvedValue({ status: 'QUEUED' }),
      getAppName: jest.fn().mockReturnValue('WIEZ'),
    };
    passwordService = {
      hashPassword: jest.fn().mockResolvedValue('hashed-code'),
      verifyPassword: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StandardOrderEscrowService,
          useValue: { getReleasedBalance: jest.fn() },
        },
        { provide: CommissionService, useValue: { resolveRule: jest.fn() } },
        {
          provide: StandardOrderFinanceSyncService,
          useValue: { syncPaidOrdersByOrderIds: jest.fn() },
        },
        {
          provide: CustomOrderFinanceSyncService,
          useValue: { syncBrand: jest.fn() },
        },
        { provide: PasswordService, useValue: passwordService },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get<PayoutService>(PayoutService);

    // The money maths is exercised elsewhere; these tests are about the
    // authorisation gate in front of it.
    jest.spyOn(service as any, 'assertBrandExists').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'assertPayoutAccountReadyForRequest')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncFinanceSources').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'calculateAvailableBalance')
      .mockResolvedValue(50_000);
    jest
      .spyOn(service as any, 'reserveLedgerSources')
      .mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const verifiedUser = () =>
    prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'brand@example.com',
      isEmailVerified: true,
    });

  describe('requestPayout', () => {
    it('emails a code and creates NO payout', async () => {
      verifiedUser();
      prisma.emailLoginCode.findFirst.mockResolvedValue(null);
      prisma.brand.findUnique.mockResolvedValue({ name: 'Danny' });

      const result = await service.requestPayout(BRAND_ID, 12_000, USER_ID);

      expect(result.challengeRequired).toBe(true);
      expect(result.amount).toBe(12_000);
      expect(result.emailHint).toBe('br***@example.com');
      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    /*
      The code IS the second factor. Sending it to an address nobody has proven
      control of hands that factor to whoever typed the address in.
    */
    it('refuses when the account email is not verified', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'brand@example.com',
        isEmailVerified: false,
      });

      await expect(
        service.requestPayout(BRAND_ID, 12_000, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('refuses without a signed-in actor, so no payout is unattributable', async () => {
      await expect(
        service.requestPayout(BRAND_ID, 12_000, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('supersedes any code still in flight, so only the newest one works', async () => {
      verifiedUser();
      prisma.emailLoginCode.findFirst.mockResolvedValue(null);
      prisma.brand.findUnique.mockResolvedValue({ name: 'Danny' });

      await service.requestPayout(BRAND_ID, 12_000, USER_ID);

      expect(prisma.emailLoginCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usedAt: expect.any(Date) }),
        }),
      );
    });

    it('holds a cooldown so pressing again does not invalidate the code being read', async () => {
      verifiedUser();
      prisma.emailLoginCode.findFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 5_000),
      });

      await expect(
        service.requestPayout(BRAND_ID, 12_000, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('validates the payout BEFORE sending anything', async () => {
      verifiedUser();
      (service as any).calculateAvailableBalance.mockResolvedValue(1_000);

      await expect(
        service.requestPayout(BRAND_ID, 12_000, USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(emailService.send).not.toHaveBeenCalled();
    });
  });

  describe('confirmPayoutRequest', () => {
    const liveCode = (overrides: Record<string, unknown> = {}) => ({
      id: 'code-1',
      codeHash: 'hashed-code',
      attempts: 0,
      pendingValue: `${BRAND_ID}|12000.00`,
      ...overrides,
    });

    it('creates the payout for the amount the CODE authorised', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      prisma.emailLoginCode.updateMany.mockResolvedValue({ count: 1 });
      prisma.payout.create.mockResolvedValue({
        id: 'payout-1',
        currency: 'NGN',
        amount: 12_000,
        status: 'PENDING_APPROVAL',
      });

      await service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID);

      expect(prisma.payout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 12_000, brandId: BRAND_ID }),
        }),
      );
    });

    it('spends the code in the same transaction that writes the payout', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      prisma.emailLoginCode.updateMany.mockResolvedValue({ count: 1 });
      prisma.payout.create.mockResolvedValue({
        id: 'payout-1',
        currency: 'NGN',
        amount: 12_000,
        status: 'PENDING_APPROVAL',
      });

      await service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID);

      expect(prisma.emailLoginCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'code-1', usedAt: null }),
        }),
      );
    });

    /*
      Two tabs, or an impatient double press. The claim is an atomic updateMany
      against the same predicate the code was found by, so the second one sees
      zero rows and gets nothing.
    */
    it('produces no payout when the code was already claimed', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      prisma.emailLoginCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    it('rejects a code issued for a different brand', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(
        liveCode({ pendingValue: 'other-brand|12000.00' }),
      );

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    it('counts a wrong code against the attempt budget', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      passwordService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '000000', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.emailLoginCode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attempts: { increment: 1 } }),
        }),
      );
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    it('burns the code once the attempt budget is spent', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode({ attempts: 4 }));
      passwordService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '000000', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.emailLoginCode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usedAt: expect.any(Date) }),
        }),
      );
    });

    it('re-checks the balance at confirmation, not just at request', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      (service as any).calculateAvailableBalance.mockResolvedValue(1_000);

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    it('re-checks the payout account at confirmation', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(liveCode());
      (service as any).assertPayoutAccountReadyForRequest.mockRejectedValue(
        new BadRequestException('nope'),
      );

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payout.create).not.toHaveBeenCalled();
    });

    it('rejects when there is no live code at all', async () => {
      prisma.emailLoginCode.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmPayoutRequest(BRAND_ID, '123456', USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
