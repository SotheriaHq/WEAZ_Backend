import { NotFoundException } from '@nestjs/common';
import { ProfilePhotoViewService } from './profile-photo-view.service';

const VERSION_ONE = new Date('2026-06-10T08:00:00.000Z');
const VERSION_TWO = new Date('2026-06-10T09:00:00.000Z');

const makeOwner = (overrides: Record<string, unknown> = {}) => ({
  id: 'owner-user-id',
  userProfile: {
    profileImage: 'https://cdn.example.test/avatar.jpg',
    profileImageId: 'avatar-file-id',
    profileImageFile: { id: 'avatar-file-id' },
    profilePhotoUpdatedAt: VERSION_ONE,
    updatedAt: new Date('2026-06-09T08:00:00.000Z'),
    ...overrides,
  },
});

describe('ProfilePhotoViewService', () => {
  let prisma: {
    user: { findUnique: jest.Mock };
    profilePhotoView: { findUnique: jest.Mock; upsert: jest.Mock };
  };
  let service: ProfilePhotoViewService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      profilePhotoView: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    service = new ProfilePhotoViewService(prisma as any);
  });

  it('returns viewed state for anonymous viewers without writing a view row', async () => {
    const state = await service.getViewStateForOwner(makeOwner(), null);

    expect(state).toEqual({
      ownerId: 'owner-user-id',
      profilePhotoUpdatedAt: VERSION_ONE.toISOString(),
      viewed: true,
      hasUnviewedUpdate: false,
      canMarkViewed: false,
    });
    expect(prisma.profilePhotoView.findUnique).not.toHaveBeenCalled();
    expect(prisma.profilePhotoView.upsert).not.toHaveBeenCalled();
  });

  it('returns unviewed state for the owner when no self-view row exists', async () => {
    prisma.profilePhotoView.findUnique.mockResolvedValue(null);

    const state = await service.getViewStateForOwner(makeOwner(), 'owner-user-id');

    expect(prisma.profilePhotoView.findUnique).toHaveBeenCalledWith({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId: 'owner-user-id',
          viewerId: 'owner-user-id',
          photoUpdatedAt: VERSION_ONE,
        },
      },
      select: { id: true },
    });
    expect(state.viewed).toBe(false);
    expect(state.hasUnviewedUpdate).toBe(true);
    expect(state.canMarkViewed).toBe(true);
    expect(prisma.profilePhotoView.upsert).not.toHaveBeenCalled();
  });

  it('returns unviewed state per viewer when no view row exists', async () => {
    prisma.profilePhotoView.findUnique.mockResolvedValue(null);

    const state = await service.getViewStateForOwner(makeOwner(), 'viewer-user-id');

    expect(prisma.profilePhotoView.findUnique).toHaveBeenCalledWith({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId: 'owner-user-id',
          viewerId: 'viewer-user-id',
          photoUpdatedAt: VERSION_ONE,
        },
      },
      select: { id: true },
    });
    expect(state.viewed).toBe(false);
    expect(state.hasUnviewedUpdate).toBe(true);
    expect(state.canMarkViewed).toBe(true);
  });

  it('returns viewed state for that viewer when a matching view row exists', async () => {
    prisma.profilePhotoView.findUnique.mockResolvedValue({ id: 'view-row-id' });

    const state = await service.getViewStateForOwner(makeOwner(), 'viewer-user-id');

    expect(state.viewed).toBe(true);
    expect(state.hasUnviewedUpdate).toBe(false);
    expect(state.canMarkViewed).toBe(true);
  });

  it('does not mark viewed while repeatedly fetching the same unviewed photo', async () => {
    prisma.profilePhotoView.findUnique.mockResolvedValue(null);

    const firstState = await service.getViewStateForOwner(
      makeOwner(),
      'viewer-user-id',
    );
    const secondState = await service.getViewStateForOwner(
      makeOwner(),
      'viewer-user-id',
    );

    expect(firstState.hasUnviewedUpdate).toBe(true);
    expect(secondState.hasUnviewedUpdate).toBe(true);
    expect(prisma.profilePhotoView.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.profilePhotoView.upsert).not.toHaveBeenCalled();
  });

  it('resets to unviewed for a newer profile photo version', async () => {
    prisma.profilePhotoView.findUnique.mockResolvedValue(null);

    const state = await service.getViewStateForOwner(
      makeOwner({ profilePhotoUpdatedAt: VERSION_TWO }),
      'viewer-user-id',
    );

    expect(prisma.profilePhotoView.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerId_viewerId_photoUpdatedAt: {
            ownerId: 'owner-user-id',
            viewerId: 'viewer-user-id',
            photoUpdatedAt: VERSION_TWO,
          },
        },
      }),
    );
    expect(state.profilePhotoUpdatedAt).toBe(VERSION_TWO.toISOString());
    expect(state.hasUnviewedUpdate).toBe(true);
  });

  it('uses an upsert when marking viewed so duplicate view rows are not created', async () => {
    const owner = makeOwner();
    prisma.user.findUnique.mockResolvedValue(owner);
    prisma.profilePhotoView.upsert.mockResolvedValue({ id: 'view-row-id' });

    const state = await service.markViewed('owner-user-id', 'viewer-user-id');

    expect(prisma.profilePhotoView.upsert).toHaveBeenCalledWith({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId: 'owner-user-id',
          viewerId: 'viewer-user-id',
          photoUpdatedAt: VERSION_ONE,
        },
      },
      create: {
        ownerId: 'owner-user-id',
        viewerId: 'viewer-user-id',
        photoUpdatedAt: VERSION_ONE,
      },
      update: {
        viewedAt: expect.any(Date),
      },
    });
    expect(state.viewed).toBe(true);
    expect(state.hasUnviewedUpdate).toBe(false);
  });

  it('uses an upsert when the owner explicitly opens their own current photo', async () => {
    const owner = makeOwner();
    prisma.user.findUnique.mockResolvedValue(owner);
    prisma.profilePhotoView.upsert.mockResolvedValue({ id: 'self-view-row-id' });

    const state = await service.markViewed('owner-user-id', 'owner-user-id');

    expect(prisma.profilePhotoView.upsert).toHaveBeenCalledWith({
      where: {
        ownerId_viewerId_photoUpdatedAt: {
          ownerId: 'owner-user-id',
          viewerId: 'owner-user-id',
          photoUpdatedAt: VERSION_ONE,
        },
      },
      create: {
        ownerId: 'owner-user-id',
        viewerId: 'owner-user-id',
        photoUpdatedAt: VERSION_ONE,
      },
      update: {
        viewedAt: expect.any(Date),
      },
    });
    expect(state.viewed).toBe(true);
    expect(state.hasUnviewedUpdate).toBe(false);
    expect(state.canMarkViewed).toBe(true);
  });

  it('does not write a view row when a profile has no current photo', async () => {
    const owner = makeOwner({
      profileImage: null,
      profileImageId: null,
      profileImageFile: null,
      profilePhotoUpdatedAt: VERSION_TWO,
    });
    prisma.user.findUnique.mockResolvedValue(owner);

    const state = await service.markViewed('owner-user-id', 'viewer-user-id');

    expect(prisma.profilePhotoView.upsert).not.toHaveBeenCalled();
    expect(state.profilePhotoUpdatedAt).toBeNull();
    expect(state.viewed).toBe(true);
    expect(state.hasUnviewedUpdate).toBe(false);
  });

  it('throws when the owner profile does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.markViewed('missing-owner-id', 'viewer-user-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
