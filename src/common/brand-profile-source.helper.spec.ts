import { BrandVerificationStatus } from '@prisma/client';
import { normalizeBrandProfileForBrandResponse } from './brand-profile-source.helper';

describe('brand-profile-source helper', () => {
  it('falls back to UserProfile name and address when Brand fields are missing', () => {
    const response = normalizeBrandProfileForBrandResponse({
      username: 'fallback-username',
      firstName: 'Legacy',
      lastName: 'User',
      address: 'Legacy address',
      userProfile: {
        firstName: 'Canonical',
        lastName: 'Profile',
        address: 'Canonical address',
      },
      brand: {
        name: null,
        companyLocation: null,
        country: null,
        state: null,
        city: null,
        tags: [],
        verificationStatus: BrandVerificationStatus.NOT_SUBMITTED,
      },
    } as any);

    expect(response.brandFullName).toBe('Canonical Profile');
    expect(response.location).toBe('Canonical address');
  });
});
