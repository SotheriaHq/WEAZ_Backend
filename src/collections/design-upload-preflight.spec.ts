import { BadRequestException } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { HelperService } from './helper/Helper.service';
import { DEFAULT_FILE_SIZE_LIMITS } from 'src/admin/system-config/system-config.service';
import { FileType } from 'src/upload/upload.enums';

describe('Design image admission', () => {
  const file = (size: number) => ({
    name: '13068.jpg',
    type: 'image/jpeg',
    size,
  });

  it('keeps the 2 MiB design policy and rejects uncompressed oversized images', async () => {
    const config = {
      getMaxFileSize: jest.fn(
        async (key: string) => DEFAULT_FILE_SIZE_LIMITS[key],
      ),
    };
    const helper = new HelperService({} as never, config as never);
    expect(DEFAULT_FILE_SIZE_LIMITS['upload.maxSize.postImage']).toBe(
      2 * 1024 * 1024,
    );
    await expect(
      helper.validateFileSpec(file(1.5 * 1024 * 1024), FileType.POST_IMAGE),
    ).resolves.toBeUndefined();
    await expect(
      helper.validateFileSpec(file(9 * 1024 * 1024), FileType.POST_IMAGE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still honours a deliberately tighter administrator limit', async () => {
    const helper = new HelperService(
      {} as never,
      { getMaxFileSize: async () => 1024 * 1024 } as never,
    );
    await expect(
      helper.validateFileSpec(file(3 * 1024 * 1024), FileType.POST_IMAGE),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid files before creating a design or minting upload URLs', async () => {
    const service = Object.create(
      CollectionsService.prototype,
    ) as CollectionsService;
    const create = jest.fn();
    const presign = jest.fn();
    Object.assign(service, {
      resolveCatalogOwnerContext: jest.fn(async () => ({ ownerId: 'owner' })),
      helperservice: {
        determineFileType: jest.fn(() => FileType.POST_IMAGE),
        validateFileSpec: jest.fn(async () => {
          throw new BadRequestException('Image too large');
        }),
      },
      prisma: { collection: { create }, $transaction: jest.fn() },
      uploadService: { createPresignedUploads: presign },
    });
    await expect(
      service.initializeCollection('owner', {
        files: [file(9 * 1024 * 1024)],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
    expect((service as any).prisma.$transaction).not.toHaveBeenCalled();
    expect(presign).not.toHaveBeenCalled();
  });
});
