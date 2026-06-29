import {
  getRejectedProfileMediaUrlReason,
  resolveBannerImage,
} from './user-profile-source.helper';

describe('user profile media source helper', () => {
  const createdAt = new Date('2026-06-09T00:00:00.000Z');

  it('falls back to the durable banner file when the profile URL is blank', () => {
    const media = resolveBannerImage({
      userProfile: {
        firstName: 'Ada',
        lastName: 'Okafor',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        profilePhotoUpdatedAt: null,
        bannerImage: '',
        bannerImageId: 'banner-file-id',
        bannerImageFile: {
          id: 'banner-file-id',
          s3Key: 'BANNER_IMAGE/user/banner-file-id.jpg',
          s3Url: 'https://cdn.example.com/banner.jpg',
          fileName: 'banner.jpg',
          originalName: 'banner-original.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          createdAt,
          updatedAt: createdAt,
        },
        profileVisibility: 'UNLOCKED',
        updatedAt: createdAt,
      },
    });

    expect(media).toEqual(
      expect.objectContaining({
        url: 'https://cdn.example.com/banner.jpg',
        fileId: 'banner-file-id',
      }),
    );
  });

  it('rejects temporary client and signed display URLs for persistence', () => {
    expect(
      getRejectedProfileMediaUrlReason('blob:http://localhost/banner'),
    ).toBe('temporary-client-url');
    expect(
      getRejectedProfileMediaUrlReason(
        'https://bucket.s3.amazonaws.com/banner.jpg?X-Amz-Signature=test',
      ),
    ).toBe('signed-display-url');
    expect(
      getRejectedProfileMediaUrlReason('https://cdn.example.com/banner.jpg'),
    ).toBeNull();
  });
});
