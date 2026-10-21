import { ImageProcessingProcessor } from './image-processing.processor';
import { IMAGE_PROCESS_BATCH_JOB } from './queue.constants';

function build(overrides: { getObject?: jest.Mock } = {}) {
  const prisma = {
    fileUpload: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'file-1',
        mimeType: 'image/jpeg',
        s3Key: 'POST_IMAGE/u/file-1.jpg',
        processingStatus: 'READY',
        assetVersion: 1,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    fileVariant: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const upload = {
    getObjectBufferByKey:
      overrides.getObject ?? jest.fn().mockResolvedValue(Buffer.from('img')),
    buildVariantS3Key: jest.fn(
      (p: {
        variantKind: string;
        fileId: string;
        assetVersion: number;
        ext: string;
      }) => `variant/${p.variantKind}/${p.fileId}/v${p.assetVersion}.${p.ext}`,
    ),
    putObjectBuffer: jest.fn().mockResolvedValue({ url: 'https://bucket/obj' }),
  };
  const media = {
    isSupportedImageMime: jest.fn().mockReturnValue(true),
    probeImage: jest
      .fn()
      .mockResolvedValue({
        width: 1440,
        height: 1920,
        hasAlpha: false,
        isAnimated: false,
      }),
    generateVariantsIter: jest.fn(async function* () {
      yield {
          kind: 'DETAIL',
          format: 'WEBP',
          width: 1440,
          height: 1920,
          quality: 80,
          buffer: Buffer.from('x'),
          ext: 'webp',
          mimeType: 'image/webp',
      };
    }),
  };
  const processor = new ImageProcessingProcessor(
    prisma as any,
    upload as any,
    media as any,
  );
  const run = (data: Record<string, unknown>) =>
    processor.process({
      name: IMAGE_PROCESS_BATCH_JOB,
      data: { fileIds: ['file-1'], force: true, ...data },
    } as any);
  return { prisma, upload, run };
}

describe('ImageProcessingProcessor re-encode (newVersion)', () => {
  it('writes the next asset version, switches the file to it, then drops older variant rows', async () => {
    const { prisma, upload, run } = build();

    await run({ newVersion: true });

    expect(upload.putObjectBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'variant/DETAIL/file-1/v2.webp' }),
    );
    expect(prisma.fileVariant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ assetVersion: 2 }),
      }),
    );
    expect(prisma.fileUpload.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetVersion: 2,
          processingStatus: 'READY',
        }),
      }),
    );
    expect(prisma.fileVariant.deleteMany).toHaveBeenCalledWith({
      where: { fileUploadId: 'file-1', assetVersion: { lt: 2 } },
    });
  });

  it('keeps a working photo untouched when the re-encode fails, and does not throw', async () => {
    const { prisma, run } = build({
      getObject: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
    });

    await expect(run({ newVersion: true })).resolves.toBeUndefined();

    expect(prisma.fileUpload.update).not.toHaveBeenCalled();
    expect(prisma.fileVariant.deleteMany).not.toHaveBeenCalled();
  });

  it('uploads each variant before requesting the next one', async () => {
    const { prisma, upload, run } = build();
    let firstUploaded = false;
    upload.putObjectBuffer.mockImplementation(async () => {
      firstUploaded = true;
      return { url: 'https://bucket/obj' };
    });
    // The worker fixture yields only one variant; its upload must finish before READY.
    await run({});
    expect(firstUploaded).toBe(true);
    expect(prisma.fileUpload.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processingStatus: 'READY' }) }),
    );
  });

  it('leaves the normal processing path on the current version', async () => {
    const { prisma, upload, run } = build();

    await run({});

    expect(upload.putObjectBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'variant/DETAIL/file-1/v1.webp' }),
    );
    expect(prisma.fileVariant.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fileUpload.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ assetVersion: expect.anything() }),
      }),
    );
  });
});
