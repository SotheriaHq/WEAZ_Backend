import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  BrandMemberRole,
  BrandMemberStatus,
  Role,
  UserStatus,
  UserType,
} from '@prisma/client';

import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailService } from 'src/email/email.service';
import { TrustedDeviceService } from './helper/trusted-device.service';
import { toAuthUserResponse } from './helper/prisma-select.helper';
import { GoogleTokenVerifierService } from './helper/google-token-verifier.service';
import { LegalService } from 'src/legal/legal.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockPasswordService = {
    hashPassword: jest.fn(),
    verifyPassword: jest.fn(),
  };

  const mockTokenService = {
    generateTokens: jest.fn(),
    revokeOtherRefreshTokens: jest.fn(),
  };

  const mockUserHelperService = {
    generateUniqueUsername: jest.fn(),
    generateUsernameFromBrand: jest.fn(),
    generateIndustriNumber: jest.fn(),
  };

  const mockEmailVerificationHelper = {
    generateVerificationCode: jest.fn(),
    generateVerificationLink: jest.fn(),
  };

  const mockNotifications = {
    create: jest.fn(),
  };

  const mockEmailService = {
    send: jest.fn(),
    getAppName: jest.fn(() => 'WIEZ'),
  };

  const mockTrustedDeviceService = {
    listDevices: jest.fn(),
    revokeDevice: jest.fn(),
  };

  const mockGoogleTokenVerifier = {
    verifyIdToken: jest.fn(),
  };

  const mockLegalService = {
    getRequiredSignupDocuments: jest.fn(() => []),
    assertRequiredCurrentAcceptances: jest.fn(),
    recordAcceptedDocuments: jest.fn(),
  };

  const mockPrisma: any = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userProfile: {
      upsert: jest.fn(),
    },
    brandMember: {
      create: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: PasswordService,
          useValue: mockPasswordService,
        },
        { provide: TokenService, useValue: mockTokenService },
        { provide: UserHelperService, useValue: mockUserHelperService },
        {
          provide: EmailVerificationHelperService,
          useValue: mockEmailVerificationHelper,
        },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: EmailService, useValue: mockEmailService },
        { provide: TrustedDeviceService, useValue: mockTrustedDeviceService },
        {
          provide: GoogleTokenVerifierService,
          useValue: mockGoogleTokenVerifier,
        },
        { provide: LegalService, useValue: mockLegalService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('validateUser should normalize email before query', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(false);

    await service.validateUser('  TEST@example.com  ', 'password');

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: {
            equals: 'test@example.com',
            mode: 'insensitive',
          },
        },
      }),
    );
  });

  it('validateUser should return null when password is invalid', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      status: UserStatus.ACTIVE,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(false);

    await expect(
      service.validateUser('user@example.com', 'wrong-password'),
    ).resolves.toBeNull();
  });

  it('validateUser should throw when account is not active', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      status: UserStatus.SUSPENDED,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(true);

    await expect(
      service.validateUser('user@example.com', 'correct-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('validateUser should return user data when credentials are valid', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      firstName: 'Alex',
      lastName: 'Doe',
      status: UserStatus.ACTIVE,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(true);

    const result = await service.validateUser(
      'user@example.com',
      'correct-password',
    );

    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        id: 'user-1',
        email: 'user@example.com',
      }),
    );
    expect(result).not.toHaveProperty('password');
  });

  it('auth responses include themePreference without resolvedTheme', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'dark',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.themePreference).toBe('dark');
    expect(result).not.toHaveProperty('resolvedTheme');
  });

  it('auth responses normalize legacy themePreference values to system', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'auto',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.themePreference).toBe('system');
    expect(result).not.toHaveProperty('resolvedTheme');
  });

  it('auth responses use UserProfile fields and ignore divergent legacy User profile fields', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Legacy',
      lastName: 'Name',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: 'legacy-phone',
      address: 'legacy-address',
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: 'legacy-avatar.jpg',
      profileImageId: null,
      bannerImage: 'legacy-banner.jpg',
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Profile',
        lastName: 'Owner',
        phoneNumber: null,
        address: 'profile-address',
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: 'profile-banner.jpg',
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    } as any);

    expect(result.firstName).toBe('Profile');
    expect(result.lastName).toBe('Owner');
    expect(result.phoneNumber).toBeNull();
    expect(result.address).toBe('profile-address');
    expect(result.profileImage).toBeNull();
    expect(result.bannerImage).toBe('profile-banner.jpg');
  });

  it('auth responses use Brand fields before legacy User brand fields', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'brand-owner',
      role: Role.User,
      type: UserType.BRAND,
      firstName: 'Ada',
      lastName: 'Owner',
      email: 'brand@example.com',
      status: UserStatus.ACTIVE,
      brand: {
        id: 'brand-1',
        name: 'Canonical Brand',
        description: 'Canonical description',
        country: 'Ghana',
        state: 'Greater Accra',
        city: 'Accra',
        tags: ['canonical'],
        businessType: 'Atelier',
        companyLocation: 'Accra, Ghana',
        socialInstagram: 'https://instagram.com/canonical',
        socialFacebook: 'https://facebook.com/canonical',
        socialTwitter: 'https://x.com/canonical',
        socialWebsite: 'https://canonical.example',
        cacNumber: 'CAC-CANON',
        tin: 'TIN-CANON',
        ceoNin: 'NIN-CANON',
        ceoFirstName: 'Canon',
        ceoLastName: 'Owner',
        isStoreOpen: true,
        verificationStatus: 'APPROVED',
      },
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: 'Legacy Brand',
      brandDescription: 'Legacy description',
      brandCountry: 'Nigeria',
      brandState: 'Lagos',
      brandCity: 'Ikeja',
      brandTags: ['legacy'],
      brandBusinessType: 'Legacy Type',
      socialInstagram: 'https://instagram.com/legacy',
      socialFacebook: 'https://facebook.com/legacy',
      socialTwitter: 'https://x.com/legacy',
      socialWebsite: 'https://legacy.example',
      cacNumber: 'CAC-LEGACY',
      tin: 'TIN-LEGACY',
      ceoNin: 'NIN-LEGACY',
      ceoFirstName: 'Legacy',
      ceoLastName: 'Owner',
      companyLocation: 'Lagos, Nigeria',
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
    } as any);

    expect(result.brandFullName).toBe('Canonical Brand');
    expect(result.brandDescription).toBe('Canonical description');
    expect(result.brandCountry).toBe('Ghana');
    expect(result.brandTags).toEqual(['canonical']);
    expect(result.socialFacebook).toBe('https://facebook.com/canonical');
    expect(result.cacNumber).toBe('CAC-CANON');
    expect(result.storeId).toBe('brand-1');
    expect(result.verificationStatus).toBe('APPROVED');
    expect(result.isVerifiedBrand).toBe(true);
  });

  it('auth responses include empty brand membership context for regular users', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      brandMemberships: [],
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.brandMemberships).toEqual([]);
    expect(result.activeBrandId).toBeNull();
  });

  it('auth responses include brand owner membership and keep legacy flat fields', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'brand-owner',
      role: Role.User,
      type: UserType.BRAND,
      firstName: 'Ada',
      lastName: 'Owner',
      email: 'brand@example.com',
      status: UserStatus.ACTIVE,
      brand: {
        id: 'brand-1',
        name: 'Canonical Brand',
        description: 'Canonical description',
        tags: ['canonical'],
        isStoreOpen: true,
        verificationStatus: 'APPROVED',
      },
      brandMemberships: [
        {
          brandId: 'brand-1',
          role: BrandMemberRole.OWNER,
          status: BrandMemberStatus.ACTIVE,
          brand: { id: 'brand-1', name: 'Canonical Brand' },
        },
      ],
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: 'Legacy Brand',
      brandDescription: 'Legacy description',
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: ['legacy'],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.storeId).toBe('brand-1');
    expect(result.activeBrandId).toBe('brand-1');
    expect(result.activeBrandId).not.toBe('user-1');
    expect(result.brandFullName).toBe('Canonical Brand');
    expect(result.brandDescription).toBe('Canonical description');
    expect(result.brandMemberships).toEqual([
      {
        brandId: 'brand-1',
        brandName: 'Canonical Brand',
        role: BrandMemberRole.OWNER,
        status: BrandMemberStatus.ACTIVE,
        isOwner: true,
      },
    ]);
  });

  it('auth responses include inactive memberships but choose activeBrandId from ACTIVE only', () => {
    const result = toAuthUserResponse({
      id: 'staff-1',
      username: 'staff',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Staff',
      lastName: 'Member',
      email: 'staff@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      brandMemberships: [
        {
          brandId: 'brand-invited',
          role: BrandMemberRole.MANAGER,
          status: BrandMemberStatus.INVITED,
          brand: { id: 'brand-invited', name: 'Invited Brand' },
        },
        {
          brandId: 'brand-active',
          role: BrandMemberRole.CATALOG_MANAGER,
          status: BrandMemberStatus.ACTIVE,
          brand: { id: 'brand-active', name: 'Active Brand' },
        },
      ],
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.brandMemberships).toHaveLength(2);
    expect(result.activeBrandId).toBe('brand-active');
  });

  it('auth responses do not fall back to legacy User brand fields when Brand is incomplete', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'legacy-brand',
      role: Role.User,
      type: UserType.BRAND,
      firstName: 'Ada',
      lastName: 'Owner',
      email: 'legacy@example.com',
      status: UserStatus.ACTIVE,
      brand: {
        id: 'brand-1',
        name: '',
        description: null,
        tags: [],
        isStoreOpen: false,
        verificationStatus: 'NOT_SUBMITTED',
      },
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: 'Legacy Brand',
      brandDescription: 'Legacy description',
      brandCountry: 'Nigeria',
      brandState: 'Lagos',
      brandCity: 'Ikeja',
      brandTags: ['legacy'],
      brandBusinessType: 'Legacy Type',
      socialInstagram: 'https://instagram.com/legacy',
      socialFacebook: 'https://facebook.com/legacy',
      socialTwitter: 'https://x.com/legacy',
      socialWebsite: 'https://legacy.example',
      cacNumber: 'CAC-LEGACY',
      tin: 'TIN-LEGACY',
      ceoNin: 'NIN-LEGACY',
      ceoFirstName: 'Legacy',
      ceoLastName: 'Owner',
      companyLocation: 'Lagos, Nigeria',
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
    } as any);

    expect(result.brandFullName).toBeNull();
    expect(result.brandDescription).toBeNull();
    expect(result.brandTags).toEqual([]);
    expect(result.socialWebsite).toBeNull();
    expect(result.cacNumber).toBeNull();
  });

  it('/auth/profile returns UserProfile fields when UserProfile exists', async () => {
    const profileFileCreatedAt = new Date('2026-05-05T01:00:00.000Z');
    const profileFileUpdatedAt = new Date('2026-05-05T02:00:00.000Z');
    const bannerFileCreatedAt = new Date('2026-05-05T03:00:00.000Z');
    const bannerFileUpdatedAt = new Date('2026-05-05T04:00:00.000Z');

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Legacy',
      lastName: 'Name',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: 'legacy-phone',
      address: 'legacy-address',
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: 'legacy-avatar.jpg',
      profileImageId: 'legacy-avatar-id',
      profileImageFile: {
        id: 'legacy-avatar-id',
        s3Url: 'legacy-avatar-s3.jpg',
        fileName: 'legacy-avatar.jpg',
        originalName: 'legacy-avatar.jpg',
        createdAt: profileFileCreatedAt,
        updatedAt: profileFileUpdatedAt,
      },
      bannerImage: 'legacy-banner.jpg',
      bannerImageId: 'legacy-banner-id',
      bannerImageFile: {
        id: 'legacy-banner-id',
        s3Url: 'legacy-banner-s3.jpg',
        fileName: 'legacy-banner.jpg',
        originalName: 'legacy-banner.jpg',
        createdAt: bannerFileCreatedAt,
        updatedAt: bannerFileUpdatedAt,
      },
      isEmailVerified: true,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Profile',
        lastName: 'Owner',
        phoneNumber: 'profile-phone',
        address: 'profile-address',
        profileImage: 'profile-avatar.jpg',
        profileImageId: 'profile-avatar-id',
        profileImageFile: {
          id: 'profile-avatar-id',
          s3Url: 'profile-avatar-s3.jpg',
          fileName: 'profile-avatar.jpg',
          originalName: 'profile-avatar-original.jpg',
          createdAt: profileFileCreatedAt,
          updatedAt: profileFileUpdatedAt,
        },
        bannerImage: 'profile-banner.jpg',
        bannerImageId: 'profile-banner-id',
        bannerImageFile: {
          id: 'profile-banner-id',
          s3Url: 'profile-banner-s3.jpg',
          fileName: 'profile-banner.jpg',
          originalName: 'profile-banner-original.jpg',
          createdAt: bannerFileCreatedAt,
          updatedAt: bannerFileUpdatedAt,
        },
        profileVisibility: 'UNLOCKED',
      },
    });

    const result = await service.getProfileWithImage('user-1');

    expect(result).toEqual(
      expect.objectContaining({
        firstName: 'Profile',
        lastName: 'Owner',
        phoneNumber: 'profile-phone',
        address: 'profile-address',
        profileImage: 'profile-avatar.jpg',
        profileImageId: 'profile-avatar-id',
        bannerImage: 'profile-banner.jpg',
        bannerImageId: 'profile-banner-id',
      }),
    );
    expect(result.profileImageFile).toEqual(
      expect.objectContaining({
        id: 'profile-avatar-id',
        s3Url: 'profile-avatar-s3.jpg',
        createdAt: profileFileCreatedAt.toISOString(),
        updatedAt: profileFileUpdatedAt.toISOString(),
      }),
    );
    expect(result.bannerImageFile).toEqual(
      expect.objectContaining({
        id: 'profile-banner-id',
        s3Url: 'profile-banner-s3.jpg',
        createdAt: bannerFileCreatedAt.toISOString(),
        updatedAt: bannerFileUpdatedAt.toISOString(),
      }),
    );
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ userProfile: expect.any(Object) }),
      }),
    );
  });

  it('/auth/profile keeps flat fields null/empty when UserProfile is missing instead of using legacy User columns', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Legacy',
      lastName: 'User',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: 'legacy-phone',
      address: 'legacy-address',
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: 'legacy-avatar.jpg',
      profileImageId: 'legacy-avatar-id',
      profileImageFile: null,
      bannerImage: 'legacy-banner.jpg',
      bannerImageId: 'legacy-banner-id',
      bannerImageFile: null,
      isEmailVerified: true,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: null,
    });

    const result = await service.getProfileWithImage('user-1');

    expect(result).toEqual(
      expect.objectContaining({
        firstName: '',
        lastName: '',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        bannerImage: null,
        bannerImageId: null,
      }),
    );
  });

  it('auth responses do not expose password or auth internals', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      password: 'hashed-password',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 42,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: null,
    } as any);

    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('authVersion');
  });

  it('signup creates a UserProfile for regular users', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockUserHelperService.generateUniqueUsername.mockResolvedValue('alex-doe');
    mockPasswordService.hashPassword.mockResolvedValue('hashed-password');
    mockEmailVerificationHelper.generateVerificationCode.mockReturnValue(
      '123456',
    );
    mockEmailVerificationHelper.generateVerificationLink.mockReturnValue(
      'https://wiez.test/verify',
    );
    mockEmailService.send.mockResolvedValue({ dispatchStatus: 'SENT' });
    mockNotifications.create.mockResolvedValue({});
    mockTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
    });
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-1',
      username: 'alex-doe',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Legacy',
      lastName: 'User',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: false,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Alex',
        lastName: 'Doe',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: null,
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    });

    const result = await service.CreateUser(
      {
        firstName: 'Alex',
        lastName: 'Doe',
        email: 'alex@example.com',
        password: 'StrongerPassword123!',
        type: UserType.REGULAR,
      },
      { headers: {}, socket: {} } as any,
      {} as any,
    );

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userProfile: {
            create: expect.objectContaining({
              firstName: 'Alex',
              lastName: 'Doe',
            }),
          },
        }),
      }),
    );
    expect(result.user.firstName).toBe('Alex');
    expect(result.user.lastName).toBe('Doe');
  });

  it('signup creates a UserProfile for brand users', async () => {
    const createdBrandUser = {
      id: 'user-1',
      username: 'ada-style',
      role: Role.User,
      type: UserType.BRAND,
      firstName: 'Ada',
      lastName: 'Okafor',
      email: 'ada@example.com',
      status: UserStatus.ACTIVE,
      brand: {
        id: 'brand-1',
        name: 'Ada Style',
        isStoreOpen: false,
        verificationStatus: 'NOT_SUBMITTED',
      },
      brandMemberships: [
        {
          brandId: 'brand-1',
          role: BrandMemberRole.OWNER,
          status: BrandMemberStatus.ACTIVE,
          brand: { id: 'brand-1', name: 'Ada Style' },
        },
      ],
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: 'Ada Style',
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
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: false,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Ada',
        lastName: 'Okafor',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: null,
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    };
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdBrandUser);
    mockUserHelperService.generateUsernameFromBrand.mockResolvedValue(
      'ada-style',
    );
    mockUserHelperService.generateIndustriNumber.mockResolvedValue('IND-123');
    mockPasswordService.hashPassword.mockResolvedValue('hashed-password');
    mockEmailVerificationHelper.generateVerificationCode.mockReturnValue(
      '123456',
    );
    mockEmailVerificationHelper.generateVerificationLink.mockReturnValue(
      'https://wiez.test/verify',
    );
    mockEmailService.send.mockResolvedValue({ dispatchStatus: 'SENT' });
    mockNotifications.create.mockResolvedValue({});
    mockTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
    });
    mockPrisma.user.create.mockResolvedValue(createdBrandUser);

    await service.CreateUser(
      {
        firstName: 'Ada',
        lastName: 'Okafor',
        email: 'ada@example.com',
        password: 'StrongerPassword123!',
        type: UserType.BRAND,
        brandFullName: 'Ada Style',
      },
      { headers: {}, socket: {} } as any,
      {} as any,
    );

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brand: {
            create: expect.objectContaining({
              name: 'Ada Style',
              industriNumber: 'IND-123',
            }),
          },
          userProfile: {
            create: expect.objectContaining({
              firstName: 'Ada',
              lastName: 'Okafor',
            }),
          },
        }),
      }),
    );
    expect(mockPrisma.brandMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: expect.any(String),
          userId: 'user-1',
          role: 'OWNER',
          status: 'ACTIVE',
          joinedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('profile update writes only whitelisted profile fields', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        firstName: 'Old',
        lastName: 'Name',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        bannerImage: null,
        bannerImageId: null,
        profileVisibility: 'UNLOCKED',
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        username: 'alex',
        role: Role.User,
        type: UserType.REGULAR,
        firstName: 'Alex',
        lastName: 'Doe',
        email: 'alex@example.com',
        status: UserStatus.ACTIVE,
        brand: null,
        adminPermissionGrants: [],
        phoneNumber: null,
        address: 'Lagos',
        brandFullName: null,
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
        cacNumber: null,
        tin: null,
        ceoNin: null,
        ceoFirstName: null,
        ceoLastName: null,
        companyLocation: null,
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
        userProfile: {
          firstName: 'Alex',
          lastName: 'Doe',
          phoneNumber: null,
          address: 'Lagos',
          profileImage: null,
          profileImageId: null,
          profileImageFile: null,
          bannerImage: null,
          bannerImageId: null,
          bannerImageFile: null,
          profileVisibility: 'UNLOCKED',
        },
      });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.userProfile.upsert.mockResolvedValue({});

    await service.updateProfile('user-1', {
      firstName: ' Alex ',
      lastName: ' Doe ',
      address: ' Lagos ',
      username: 'ignored',
    });

    expect(mockPrisma.userProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          firstName: 'Alex',
          lastName: 'Doe',
          address: 'Lagos',
        },
      }),
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: 'Alex',
          lastName: 'Doe',
          address: 'Lagos',
        }),
      }),
    );
  });

  it.each([
    ['email', 'takeover@example.com'],
    ['password', 'new-password'],
    ['role', Role.SuperAdmin],
    ['type', UserType.BRAND],
    ['brandFullName', 'Hijacked Brand'],
    ['socialInstagram', 'https://instagram.com/hijack'],
    ['cacNumber', 'CAC-HIJACK'],
    ['tin', 'TIN-HIJACK'],
    ['ceoNin', 'NIN-HIJACK'],
    ['industriNumber', 'IND-HIJACK'],
  ])('profile update rejects sensitive field %s', async (field, value) => {
    await expect(
      service.updateProfile('user-1', {
        firstName: 'Alex',
        [field]: value,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.userProfile.upsert).not.toHaveBeenCalled();
  });
});
