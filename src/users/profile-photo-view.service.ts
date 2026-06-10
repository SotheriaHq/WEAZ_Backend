import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const profilePhotoOwnerSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  userProfile: {
    select: {
      profileImage: true,
      profileImageId: true,
      profilePhotoUpdatedAt: true,
      updatedAt: true,
      profileImageFile: {
        select: {
          id: true,
        },
      },
    },
  },
});

type ProfilePhotoOwner = Prisma.UserGetPayload<{
  select: typeof profilePhotoOwnerSelect;
}>;

type ProfilePhotoSource = {
  profileImage?: string | null;
  profileImageId?: string | null;
  profilePhotoUpdatedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  profileImageFile?: { id?: string | null } | null;
} | null;

type ProfilePhotoOwnerSource = {
  id: string;
  userProfile?: ProfilePhotoSource;
};

export type ProfilePhotoViewState = {
  ownerId: string;
  profilePhotoUpdatedAt: string | null;
  viewed: boolean;
  hasUnviewedUpdate: boolean;
  canMarkViewed: boolean;
};

@Injectable()
export class ProfilePhotoViewService {
  constructor(private readonly prisma: PrismaService) {}

  private hasProfilePhoto(profile: ProfilePhotoSource): boolean {
    return Boolean(
      profile &&
        (this.filledString(profile.profileImage) ||
          this.filledString(profile.profileImageId) ||
          this.filledString(profile.profileImageFile?.id)),
    );
  }

  private filledString(value?: string | null): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
  }

  private coerceDate(value?: Date | string | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private resolvePhotoVersion(profile: ProfilePhotoSource): Date | null {
    if (!this.hasProfilePhoto(profile)) return null;
    return (
      this.coerceDate(profile?.profilePhotoUpdatedAt) ??
      this.coerceDate(profile?.updatedAt)
    );
  }

  private buildState(
    owner: ProfilePhotoOwnerSource,
    viewerId?: string | null,
    viewed = false,
  ): ProfilePhotoViewState {
    const photoVersion = this.resolvePhotoVersion(owner.userProfile ?? null);
    const canMarkViewed = Boolean(
      photoVersion && viewerId && viewerId !== owner.id,
    );
    const isViewed = canMarkViewed ? viewed : true;

    return {
      ownerId: owner.id,
      profilePhotoUpdatedAt: photoVersion?.toISOString() ?? null,
      viewed: isViewed,
      hasUnviewedUpdate: canMarkViewed ? !isViewed : false,
      canMarkViewed,
    };
  }

  async getViewState(
    ownerId: string,
    viewerId?: string | null,
  ): Promise<ProfilePhotoViewState> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: profilePhotoOwnerSelect,
    });

    if (!owner) {
      throw new NotFoundException('User not found');
    }

    return this.getViewStateForOwner(owner, viewerId);
  }

  async getViewStateForOwner(
    owner: ProfilePhotoOwnerSource,
    viewerId?: string | null,
  ): Promise<ProfilePhotoViewState> {
    const photoVersion = this.resolvePhotoVersion(owner.userProfile ?? null);
    if (!photoVersion || !viewerId || viewerId === owner.id) {
      return this.buildState(owner, viewerId, true);
    }

    const existingView = await this.prisma.profilePhotoView.findUnique({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId: owner.id,
          viewerId,
          photoUpdatedAt: photoVersion,
        },
      },
      select: { id: true },
    });

    return this.buildState(owner, viewerId, Boolean(existingView));
  }

  async markViewed(
    ownerId: string,
    viewerId: string,
  ): Promise<ProfilePhotoViewState> {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: profilePhotoOwnerSelect,
    });

    if (!owner) {
      throw new NotFoundException('User not found');
    }

    const photoVersion = this.resolvePhotoVersion(owner.userProfile ?? null);
    if (!photoVersion || viewerId === owner.id) {
      return this.buildState(owner, viewerId, true);
    }

    await this.prisma.profilePhotoView.upsert({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId,
          viewerId,
          photoUpdatedAt: photoVersion,
        },
      },
      create: {
        ownerId,
        viewerId,
        photoUpdatedAt: photoVersion,
      },
      update: {
        viewedAt: new Date(),
      },
    });

    return this.buildState(owner, viewerId, true);
  }
}
