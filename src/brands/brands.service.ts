import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionStatus, Prisma, UserType } from '@prisma/client';
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import {
  profileUserSelect,
  toAuthUserResponse,
} from '../auth/helper/prisma-select.helper';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';

export interface BrandMediaAsset {
  fileId: string;
  url: string;
  originalName: string | null;
  fileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandProfileResponse {
  id: string;
  brandFullName: string;
  description: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  location: string | null;
  bannerImage: string | null;
  bannerImageMeta: BrandMediaAsset | null;
  logoImage: string | null;
  logoImageMeta: BrandMediaAsset | null;
  socialLinks: {
    instagram?: string | null;
    facebook?: string | null;
    twitter?: string | null;
    website?: string | null;
  };
  contactInfo: {
    email: string;
    phone?: string | null;
    businessType?: string | null;
  };
  tags: string[];
  hashtags: string[];
  cacNumber: string | null;
  tin: string | null;
  verified: boolean;
  averageRating: number;
  totalReviews: number;
  collectionsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandReviewsResponse {
  reviews: Array<{
    id: string;
    userId: string;
    userName: string;
    userImage: string | null;
    brandId: string;
    rating: number;
    comment: string;
    helpful: number;
    images: string[];
    verified: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  averageRating: number;
  totalReviews: number;
  ratingDistribution: Array<{
    stars: number;
    count: number;
    percentage: number;
  }>;
}

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getBrandOrThrow(brandId: string) {
    const brand = await this.prisma.user.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        address: true,
        brandFullName: true,
        brandDescription: true,
        brandCountry: true,
        brandState: true,
        brandCity: true,
        brandTags: true,
        brandBusinessType: true,
        socialInstagram: true,
        socialFacebook: true,
        socialTwitter: true,
        socialWebsite: true,
        companyLocation: true,
        profileImage: true,
        profileImageFile: {
          select: {
            id: true,
            s3Url: true,
            fileName: true,
            originalName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        bannerImage: true,
        bannerImageId: true,
        bannerImageFile: {
          select: {
            id: true,
            s3Url: true,
            fileName: true,
            originalName: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        cacNumber: true,
        tin: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true,
        type: true,
      },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new NotFoundException('Brand not found');
    }

    return brand;
  }

  async getBrandProfile(brandId: string): Promise<BrandProfileResponse> {
    const brand = await this.getBrandOrThrow(brandId);

    const collectionsCount = await this.prisma.collection.count({
      where: {
        ownerId: brandId,
        status: CollectionStatus.PUBLISHED,
      },
    });

    const fullName =
      brand.brandFullName ||
      [brand.firstName, brand.lastName].filter(Boolean).join(' ').trim() ||
      brand.username;

    const country = brand.brandCountry || null;
    const state = brand.brandState || null;
    const city = brand.brandCity || null;

    const computedLocation = [city, state, country]
      .filter((part) => Boolean(part && part.trim().length > 0))
      .join(', ');

    const location =
      computedLocation || brand.companyLocation || brand.address || null;

    const logoAsset = brand.profileImageFile
      ? {
          fileId: brand.profileImageFile.id,
          url: brand.profileImageFile.s3Url,
          originalName: brand.profileImageFile.originalName ?? null,
          fileName: brand.profileImageFile.fileName ?? null,
          createdAt: brand.profileImageFile.createdAt.toISOString(),
          updatedAt: brand.profileImageFile.updatedAt.toISOString(),
        }
      : null;
    const bannerAsset = brand.bannerImageFile
      ? {
          fileId: brand.bannerImageFile.id,
          url: brand.bannerImageFile.s3Url,
          originalName: brand.bannerImageFile.originalName ?? null,
          fileName: brand.bannerImageFile.fileName ?? null,
          createdAt: brand.bannerImageFile.createdAt.toISOString(),
          updatedAt: brand.bannerImageFile.updatedAt.toISOString(),
        }
      : null;

    const logoImage = logoAsset?.url || brand.profileImage || null;
    const bannerImage = bannerAsset?.url || brand.bannerImage || null;

    return {
      id: brand.id,
      brandFullName: fullName,
      description: brand.brandDescription ?? null,
      country,
      state,
      city,
      location,
      bannerImage,
      bannerImageMeta: bannerAsset,
      logoImage,
      logoImageMeta: logoAsset,
      socialLinks: {
        instagram: brand.socialInstagram ?? null,
        facebook: brand.socialFacebook ?? null,
        twitter: brand.socialTwitter ?? null,
        website: brand.socialWebsite ?? null,
      },
      contactInfo: {
        email: brand.email,
        phone: brand.phoneNumber ?? null,
        businessType: brand.brandBusinessType?.trim() || 'Fashion Brand',
      },
      tags: brand.brandTags ?? [],
      hashtags: brand.brandTags ?? [],
      cacNumber: brand.cacNumber ?? null,
      tin: brand.tin ?? null,
      verified: Boolean(brand.isEmailVerified),
      averageRating: 0,
      totalReviews: 0,
      collectionsCount,
      createdAt: brand.createdAt.toISOString(),
      updatedAt: brand.updatedAt.toISOString(),
    };
  }

  async getBrandReviews(brandId: string): Promise<BrandReviewsResponse> {
    await this.getBrandOrThrow(brandId);

    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: 0,
      percentage: 0,
    }));

    return {
      reviews: [],
      averageRating: 0,
      totalReviews: 0,
      ratingDistribution: distribution,
    };
  }

  async updateBrandProfile(
    brandId: string,
    dto: UpdateBrandProfileDto,
  ): Promise<AuthUserResponseDto> {
    await this.getBrandOrThrow(brandId);

    const trimOrNull = (value: string | undefined): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const sanitizedTags = Array.isArray(dto.brandTags)
      ? Array.from(
          new Set(
            dto.brandTags
              .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
              .filter((tag) => tag.length > 0),
          ),
        ).slice(0, 6)
      : undefined;

    const brandCountry = trimOrNull(dto.brandCountry);
    const brandState = trimOrNull(dto.brandState);
    const brandCity = trimOrNull(dto.brandCity);

    const companyLocation = [brandCity, brandState, brandCountry]
      .filter((segment) => Boolean(segment))
      .join(', ');

    const locationWasProvided =
      dto.brandCountry !== undefined ||
      dto.brandState !== undefined ||
      dto.brandCity !== undefined;

    const data: Prisma.UserUpdateInput = {
      ...(dto.brandFullName !== undefined && {
        brandFullName: trimOrNull(dto.brandFullName),
      }),
      ...(dto.brandDescription !== undefined && {
        brandDescription: trimOrNull(dto.brandDescription),
      }),
      ...(dto.brandCountry !== undefined && { brandCountry }),
      ...(dto.brandState !== undefined && { brandState }),
      ...(dto.brandCity !== undefined && { brandCity }),
      ...(sanitizedTags !== undefined && { brandTags: sanitizedTags }),
      ...(dto.socialInstagram !== undefined && {
        socialInstagram: trimOrNull(dto.socialInstagram),
      }),
      ...(dto.socialFacebook !== undefined && {
        socialFacebook: trimOrNull(dto.socialFacebook),
      }),
      ...(dto.socialTwitter !== undefined && {
        socialTwitter: trimOrNull(dto.socialTwitter),
      }),
      ...(dto.socialWebsite !== undefined && {
        socialWebsite: trimOrNull(dto.socialWebsite),
      }),
      ...(dto.businessType !== undefined && {
        brandBusinessType: trimOrNull(dto.businessType),
      }),
      ...(dto.phoneNumber !== undefined && {
        phoneNumber: trimOrNull(dto.phoneNumber),
      }),
      ...(locationWasProvided
        ? {
            companyLocation:
              companyLocation.length > 0 ? companyLocation : null,
          }
        : {}),
    };

    const updatedUser = await this.prisma.user.update({
      where: { id: brandId },
      data,
      select: profileUserSelect,
    });

    return toAuthUserResponse(updatedUser);
  }
}
