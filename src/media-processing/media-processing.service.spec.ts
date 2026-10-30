import { BadRequestException } from '@nestjs/common';
import type sharpTypes from 'sharp';
import { createRequire } from 'node:module';
const runtimeRequire = createRequire(__filename);
const sharp = runtimeRequire('sharp') as typeof sharpTypes;
import { MediaProcessingService } from './media-processing.service';

describe('MediaProcessingService', () => {
  let service: MediaProcessingService;

  const makeNoisyJpeg = async (width: number, height: number) => {
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i += 1) {
      raw[i] = Math.floor(Math.random() * 256);
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
  };

  const makeFakeHeicBuffer = () => {
    const buffer = Buffer.alloc(32);
    buffer.write('ftyp', 4, 'ascii');
    buffer.write('heic', 8, 'ascii');
    return buffer;
  };

  const makeCompatibleBrandHeicBuffer = () => {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32BE(32, 0);
    buffer.write('ftyp', 4, 'ascii');
    buffer.write('qt  ', 8, 'ascii');
    buffer.writeUInt32BE(0, 12);
    buffer.write('heic', 16, 'ascii');
    buffer.write('mif1', 20, 'ascii');
    return buffer;
  };

  beforeEach(() => {
    service = new MediaProcessingService();
  });

  it('encodes decodable AVIF and WebP variants without enlarging the source', async () => {
    const source = await makeNoisyJpeg(48, 32);
    const variants = await service.generateVariants(source, {
      mimeType: 'image/jpeg',
    });
    expect(variants.some((variant) => variant.format === 'AVIF')).toBe(true);
    expect(variants.some((variant) => variant.format === 'WEBP')).toBe(true);
    for (const variant of variants) {
      const metadata = await sharp(variant.buffer).metadata();
      expect(metadata.width).toBe(variant.width);
      expect(metadata.height).toBe(variant.height);
      expect(variant.width).toBeLessThanOrEqual(48);
      expect(variant.height).toBeLessThanOrEqual(32);
    }
  }, 30_000);

  it('retains fine coloured fabric detail in the actual display variants', async () => {
    const { fixture, metrics } = runtimeRequire(
      '../../scripts/benchmark-image-quality.cjs',
    );
    const input = fixture('weave', 256, 384);
    const source = await sharp(input.pixels, { raw: input })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const reference = await sharp(source).raw().toBuffer();
    const variants = await service.generateVariants(source, {
      mimeType: 'image/jpeg',
    });
    for (const format of ['WEBP', 'AVIF']) {
      const detail = variants.find(
        (variant) => variant.kind === 'DETAIL' && variant.format === format,
      )!;
      const decoded = await sharp(detail.buffer).removeAlpha().raw().toBuffer();
      expect(
        metrics(reference, decoded, 256, 384, 3).rgbSsim8x8,
      ).toBeGreaterThan(0.95);
    }
  }, 30_000);

  it('preserves every RGBA value in transparent display images', async () => {
    const { fixture } = runtimeRequire(
      '../../scripts/benchmark-image-quality.cjs',
    );
    const input = fixture('alpha', 48, 64);
    const source = await sharp(input.pixels, { raw: input }).png().toBuffer();
    const variants = await service.generateVariants(source, {
      mimeType: 'image/png',
    });
    for (const format of ['PNG', 'WEBP']) {
      const detail = variants.find(
        (variant) => variant.kind === 'DETAIL' && variant.format === format,
      )!;
      const decoded = await sharp(detail.buffer).ensureAlpha().raw().toBuffer();
      expect(decoded).toEqual(input.pixels);
    }
  }, 30_000);

  it('keeps resized PNG full-colour rather than quantising it to a palette', async () => {
    const { fixture } = runtimeRequire(
      '../../scripts/benchmark-image-quality.cjs',
    );
    const input = fixture('alpha', 512, 768);
    const source = await sharp(input.pixels, { raw: input }).png().toBuffer();
    const expected = await sharp(source)
      .rotate()
      .withIccProfile('srgb')
      .resize({ width: 256, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for await (const variant of service.generateVariantsIter(source, {
      mimeType: 'image/png',
    })) {
      expect(variant.kind).toBe('AVATAR');
      expect(variant.format).toBe('PNG');
      expect((await sharp(variant.buffer).metadata()).isPalette).toBe(false);
      expect(
        await sharp(variant.buffer).ensureAlpha().raw().toBuffer(),
      ).toEqual(expected);
      break;
    }
  }, 30_000);

  it('uses oriented dimensions and strips EXIF while keeping the colour profile', async () => {
    const source = await sharp({
      create: { width: 48, height: 32, channels: 3, background: '#bb3344' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await service.probeImage(source)).toMatchObject({
      width: 32,
      height: 48,
    });
    const variants = await service.generateVariants(source, {
      mimeType: 'image/jpeg',
    });
    for (const variant of variants) {
      const metadata = await sharp(variant.buffer).metadata();
      expect(metadata).toMatchObject({ width: 32, height: 48 });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeDefined();
    }
  }, 30_000);

  describe('isHeicLikeBuffer', () => {
    it('detects HEIC ftyp brands', () => {
      expect(service.isHeicLikeBuffer(makeFakeHeicBuffer())).toBe(true);
    });

    it('detects HEIC compatible brands when major brand is generic', () => {
      expect(service.isHeicLikeBuffer(makeCompatibleBrandHeicBuffer())).toBe(
        true,
      );
    });

    it('rejects JPEG and short buffers', async () => {
      const jpeg = await makeNoisyJpeg(32, 32);
      expect(service.isHeicLikeBuffer(jpeg)).toBe(false);
      expect(service.isHeicLikeBuffer(Buffer.alloc(4))).toBe(false);
    });
  });

  describe('toDecodableImageBuffer', () => {
    it('passes sharp-decodable buffers through untouched', async () => {
      const jpeg = await makeNoisyJpeg(32, 32);
      await expect(service.toDecodableImageBuffer(jpeg)).resolves.toBe(jpeg);
    });

    it('converts HEIC-branded buffers after bounded container metadata validation', async () => {
      // Real phone HEIC often passes sharp.metadata() (container read) but fails
      // later at jpeg().toBuffer() — conversion must run on ftyp sniff, not on
      // metadata() throwing.
      const jpeg = await makeNoisyJpeg(32, 32);
      const jpegArrayBuffer = jpeg.buffer.slice(
        jpeg.byteOffset,
        jpeg.byteOffset + jpeg.byteLength,
      ) as ArrayBuffer;
      const convertSpy = jest
        .spyOn(
          service as unknown as {
            convertHeicToPng: (buf: Buffer) => Promise<ArrayBuffer>;
          },
          'convertHeicToPng',
        )
        .mockResolvedValue(jpegArrayBuffer);
      const metadataSpy = jest
        .spyOn(sharp.prototype, 'metadata')
        .mockResolvedValueOnce({
          format: 'heif',
          width: 32,
          height: 32,
        } as any);
      try {
        await expect(
          service.toDecodableImageBuffer(makeFakeHeicBuffer()),
        ).resolves.toEqual(jpeg);
        expect(convertSpy).toHaveBeenCalledTimes(1);
      } finally {
        convertSpy.mockRestore();
        metadataSpy.mockRestore();
      }
    });

    it('rejects malformed HEIC-branded buffers as bad input', async () => {
      // A bare ftyp box is refused before allocating the WASM decoder.
      await expect(
        service.toDecodableImageBuffer(makeFakeHeicBuffer()),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-HEIC garbage as bad input', async () => {
      await expect(
        service.toDecodableImageBuffer(Buffer.alloc(64, 0x41)),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('generatePreviewJpeg', () => {
    it('produces a JPEG preview capped at maxWidth', async () => {
      const jpeg = await makeNoisyJpeg(1600, 1200);
      const preview = await service.generatePreviewJpeg(jpeg, {
        maxWidth: 800,
        quality: 82,
      });
      expect(preview.mimeType).toBe('image/jpeg');
      expect(preview.width).toBeLessThanOrEqual(800);
      expect(preview.buffer.length).toBeGreaterThan(0);
    }, 30_000);

    it('steps quality/size down until the output fits maxBytes', async () => {
      const jpeg = await makeNoisyJpeg(1600, 1200);
      const capBytes = 150 * 1024;
      const preview = await service.generatePreviewJpeg(jpeg, {
        maxWidth: 1600,
        quality: 82,
        maxBytes: capBytes,
      });
      expect(preview.buffer.length).toBeLessThanOrEqual(capBytes);
    }, 30_000);

    it('keeps reducing dimensions until the output fits a strict maxBytes cap', async () => {
      const jpeg = await makeNoisyJpeg(1600, 1200);
      const capBytes = 100 * 1024;
      const preview = await service.generatePreviewJpeg(jpeg, {
        maxWidth: 1600,
        quality: 82,
        maxBytes: capBytes,
      });
      expect(preview.buffer.length).toBeLessThanOrEqual(capBytes);
    }, 30_000);

    it('rejects undecodable input', async () => {
      await expect(
        service.generatePreviewJpeg(Buffer.alloc(64, 0x41)),
      ).rejects.toBeDefined();
    });

    it('rejects images with undetectable dimensions', async () => {
      const svc = new MediaProcessingService();
      jest.spyOn(svc, 'probeImage').mockResolvedValue({
        width: null,
        height: null,
        hasAlpha: false,
        isAnimated: false,
        orientation: null,
        colorSpace: null,
        format: null,
      });
      const jpeg = await makeNoisyJpeg(32, 32);
      await expect(svc.generatePreviewJpeg(jpeg)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
