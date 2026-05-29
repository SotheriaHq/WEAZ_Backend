import { ForbiddenException } from '@nestjs/common';
import { BrandsController } from './brands.controller';

describe('BrandsController brand access endpoints', () => {
  const brandsService = {
    updateBrandProfile: jest.fn(),
  };
  const collectionsService = {};
  const brandVerificationService = {
    submit: jest.fn(),
    resubmitInfo: jest.fn(),
  };
  const brandAccessService = {
    assertCanUpdateBrandProfile: jest.fn(),
    assertCanSubmitVerification: jest.fn(),
  };

  const controller = new BrandsController(
    brandsService as any,
    collectionsService as any,
    brandVerificationService as any,
    brandAccessService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('brand owner can update brand profile', async () => {
    brandAccessService.assertCanUpdateBrandProfile.mockResolvedValue(undefined);
    brandsService.updateBrandProfile.mockResolvedValue({ id: 'owner-1' });

    await expect(
      controller.updateBrandProfile(
        'brand-1',
        { brandFullName: 'Threadly Atelier' } as any,
        { user: { id: 'owner-1' } } as any,
      ),
    ).resolves.toEqual({ id: 'owner-1' });

    expect(brandAccessService.assertCanUpdateBrandProfile).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
    );
  });

  it('regular user cannot update brand profile', async () => {
    brandAccessService.assertCanUpdateBrandProfile.mockRejectedValue(
      new ForbiddenException('Not authorized for this brand'),
    );

    await expect(
      controller.updateBrandProfile(
        'brand-1',
        { brandFullName: 'Threadly Atelier' } as any,
        { user: { id: 'regular-1' } } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(brandsService.updateBrandProfile).not.toHaveBeenCalled();
  });

  it('non-member brand user cannot update another brand', async () => {
    brandAccessService.assertCanUpdateBrandProfile.mockRejectedValue(
      new ForbiddenException('Not authorized for this brand'),
    );

    await expect(
      controller.updateBrandProfile(
        'brand-2',
        { brandFullName: 'Other Brand' } as any,
        { user: { id: 'brand-user-1' } } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(brandsService.updateBrandProfile).not.toHaveBeenCalled();
  });

  it('owner can submit and resubmit brand verification', async () => {
    brandAccessService.assertCanSubmitVerification.mockResolvedValue(undefined);
    brandVerificationService.submit.mockResolvedValue({
      verificationStatus: 'PENDING',
    });
    brandVerificationService.resubmitInfo.mockResolvedValue({
      verificationStatus: 'IN_REVIEW',
    });

    await expect(
      controller.submitVerification('brand-1', {} as any, {
        user: { id: 'owner-1' },
      }),
    ).resolves.toEqual({ verificationStatus: 'PENDING' });

    await expect(
      controller.resubmitVerificationInfo('brand-1', {} as any, {
        user: { id: 'owner-1' },
      }),
    ).resolves.toEqual({ verificationStatus: 'IN_REVIEW' });
  });

  it('non-owner non-member cannot submit brand verification', async () => {
    brandAccessService.assertCanSubmitVerification.mockRejectedValue(
      new ForbiddenException('Not authorized for this brand'),
    );

    await expect(
      controller.submitVerification('brand-1', {} as any, {
        user: { id: 'user-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(brandVerificationService.submit).not.toHaveBeenCalled();
  });
});
