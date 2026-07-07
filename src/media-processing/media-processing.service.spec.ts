import { BadRequestException } from '@nestjs/common';
import sharp = require('sharp');
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

  beforeEach(() => {
    service = new MediaProcessingService();
  });

  describe('isHeicLikeBuffer', () => {
    it('detects HEIC ftyp brands', () => {
      expect(service.isHeicLikeBuffer(makeFakeHeicBuffer())).toBe(true);
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

    it('converts HEIC-branded buffers before sharp metadata can short-circuit', async () => {
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
            convertHeicToJpeg: (buf: Buffer) => Promise<ArrayBuffer>;
          },
          'convertHeicToJpeg',
        )
        .mockResolvedValue(jpegArrayBuffer);

      await expect(
        service.toDecodableImageBuffer(makeFakeHeicBuffer()),
      ).resolves.toEqual(jpeg);

      expect(convertSpy).toHaveBeenCalledTimes(1);
      convertSpy.mockRestore();
    });

    it('routes undecodable HEIC-branded buffers into the libheif decoder', async () => {
      // A bare ftyp box is not a decodable HEIC, but the error must come from
      // the HEIC decoder — proving conversion is attempted up front.
      await expect(
        service.toDecodableImageBuffer(makeFakeHeicBuffer()),
      ).rejects.toThrow(/heif/i);
    });

    it('rethrows sharp errors for non-HEIC garbage', async () => {
      await expect(
        service.toDecodableImageBuffer(Buffer.alloc(64, 0x41)),
      ).rejects.toThrow(/unsupported image format/i);
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

    it('rejects undecodable input', async () => {
      await expect(
        service.generatePreviewJpeg(Buffer.alloc(64, 0x41)),
      ).rejects.toBeDefined();
    });

    it('rejects images with undetectable dimensions', async () => {
      const svc = new MediaProcessingService();
      jest
        .spyOn(svc, 'probeImage')
        .mockResolvedValue({
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
