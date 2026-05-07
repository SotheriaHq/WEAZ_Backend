import { Test, TestingModule } from '@nestjs/testing';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

describe('PayoutController', () => {
  let controller: PayoutController;
  let payoutService: any;
  let brandPermissionService: any;

  beforeEach(async () => {
    payoutService = {
      findAll: jest.fn(),
      getOverview: jest.fn(),
      listIncomingTransactions: jest.fn(),
      listHeldFunds: jest.fn(),
      requestPayout: jest.fn(),
      assertBrandOwnership: jest.fn(),
    };
    brandPermissionService = {
      assertPermission: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayoutController],
      providers: [
        { provide: PayoutService, useValue: payoutService },
        { provide: BrandPermissionService, useValue: brandPermissionService },
      ],
    }).compile();

    controller = module.get<PayoutController>(PayoutController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('allows payout overview with payouts.read', async () => {
    payoutService.getOverview.mockResolvedValue({ availableBalance: 1000 });

    await expect(
      controller.getOverview('brand_1', { user: { id: 'staff_1' } }),
    ).resolves.toEqual({ availableBalance: 1000 });

    expect(brandPermissionService.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.PAYOUTS_READ,
    );
  });

  it('keeps payout requests owner-only', async () => {
    payoutService.requestPayout.mockResolvedValue({ id: 'payout_1' });

    await controller.requestPayout('brand_1', { amount: 5000 }, { user: { id: 'owner_1' } });

    expect(payoutService.assertBrandOwnership).toHaveBeenCalledWith('brand_1', 'owner_1');
    expect(payoutService.requestPayout).toHaveBeenCalledWith(
      'brand_1',
      5000,
      'owner_1',
    );
    expect(brandPermissionService.assertPermission).not.toHaveBeenCalled();
  });
});
