import { Injectable, BadRequestException } from '@nestjs/common';
// import-equals form: sharp is a callable CJS export and this tsconfig has no
// esModuleInterop — default-import syntax breaks under ts-jest while working
// under the SWC production build. This form is identical under both.
import sharp = require('sharp');
import {
  IMAGE_VARIANT_PROFILES,
  IMAGE_MIME_TYPES,
  type VariantKind,
} from './variant-profile.config';

export interface ImageProbe {
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
  isAnimated: boolean;
  orientation: number | null;
  colorSpace: string | null;
  format: string | null;
}

export interface EncodedVariant {
  kind: VariantKind;
  format: 'AVIF' | 'WEBP' | 'JPEG' | 'PNG';
  width: number;
  height: number;
  quality: number;
  buffer: Buffer;
  ext: string;
  mimeType: string;
}

export interface PreviewJpeg {
  width: number;
  height: number;
  buffer: Buffer;
  mimeType: 'image/jpeg';
}

const HEIC_FTYP_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

@Injectable()
export class MediaProcessingService {
  private readonly maxMegapixels = 50;

  isSupportedImageMime(mimeType: string): boolean {
    return IMAGE_MIME_TYPES.has(String(mimeType || '').toLowerCase());
  }

  /** ISO-BMFF container with an HEVC-coded image brand (phone camera HEIC/HEIF). */
  isHeicLikeBuffer(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 12) return false;
    if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
    return HEIC_FTYP_BRANDS.has(buffer.toString('ascii', 8, 12).toLowerCase());
  }

  /**
   * Prebuilt sharp/libvips cannot decode HEIC/HEIF (HEVC patent licensing),
   * but phone cameras produce them constantly — gallery apps often hand them
   * over renamed to `.jpg`. Convert to JPEG via libheif (WASM) so the rest of
   * the pipeline never sees an undecodable buffer.
   */
  async toDecodableImageBuffer(buffer: Buffer): Promise<Buffer> {
    try {
      await sharp(buffer, { animated: true }).metadata();
      return buffer;
    } catch (error) {
      if (!this.isHeicLikeBuffer(buffer)) {
        throw error;
      }
      const converted = await this.convertHeicToJpeg(buffer);
      return Buffer.from(converted);
    }
  }

  private async convertHeicToJpeg(buffer: Buffer): Promise<ArrayBuffer> {
    type HeicConvert = (options: {
      buffer: Buffer | Uint8Array;
      format: 'JPEG' | 'PNG';
      quality?: number;
    }) => Promise<ArrayBuffer>;

    // heic-convert is CJS; dynamic import resolves to the function itself
    // under ts-jest/plain CJS but to `{ default: fn }` under the SWC build's
    // interop helper. Accept both shapes.
    const heicModule = (await import('heic-convert')) as unknown;
    const convert: HeicConvert =
      typeof heicModule === 'function'
        ? (heicModule as HeicConvert)
        : (heicModule as { default: HeicConvert }).default;

    return convert({ buffer, format: 'JPEG', quality: 0.9 });
  }

  async probeImage(buffer: Buffer): Promise<ImageProbe> {
    const metadata = await sharp(buffer, { animated: true }).metadata();
    const width = metadata.width ?? null;
    const height = metadata.height ?? null;

    if (width && height) {
      const megapixels = (width * height) / 1_000_000;
      if (megapixels > this.maxMegapixels) {
        throw new BadRequestException('Image dimensions are too large');
      }
    }

    return {
      width,
      height,
      hasAlpha: Boolean(metadata.hasAlpha),
      isAnimated: (metadata.pages ?? 1) > 1,
      orientation:
        typeof metadata.orientation === 'number' ? metadata.orientation : null,
      colorSpace: typeof metadata.space === 'string' ? metadata.space : null,
      format: typeof metadata.format === 'string' ? metadata.format : null,
    };
  }

  async generateVariants(
    sourceBuffer: Buffer,
    options: { mimeType: string; textHeavy?: boolean },
  ): Promise<EncodedVariant[]> {
    const buffer = await this.toDecodableImageBuffer(sourceBuffer);
    const probe = await this.probeImage(buffer);
    if (!probe.width || !probe.height) {
      throw new BadRequestException('Unable to detect image dimensions');
    }

    if (probe.isAnimated) {
      return [];
    }

    const variants: EncodedVariant[] = [];
    const outputFormat = this.pickPrimaryFormat(
      options.mimeType,
      probe.hasAlpha,
    );

    for (const profile of IMAGE_VARIANT_PROFILES) {
      const resized = sharp(buffer, { animated: false })
        .rotate()
        .resize({
          width: Math.min(profile.maxWidth, probe.width),
          withoutEnlargement: true,
        });

      const qualityBump = options.textHeavy ? 4 : 0;
      const quality = Math.min(95, profile.quality + qualityBump);

      if (outputFormat === 'AVIF') {
        const out = await resized
          .avif({ quality })
          .toBuffer({ resolveWithObject: true });
        variants.push({
          kind: profile.kind,
          format: 'AVIF',
          width: out.info.width,
          height: out.info.height,
          quality,
          buffer: out.data,
          ext: 'avif',
          mimeType: 'image/avif',
        });
        const webp = await resized
          .webp({ quality: Math.max(68, quality - 4) })
          .toBuffer({ resolveWithObject: true });
        variants.push({
          kind: profile.kind,
          format: 'WEBP',
          width: webp.info.width,
          height: webp.info.height,
          quality: Math.max(68, quality - 4),
          buffer: webp.data,
          ext: 'webp',
          mimeType: 'image/webp',
        });
        continue;
      }

      if (outputFormat === 'PNG') {
        const png = await resized
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
        variants.push({
          kind: profile.kind,
          format: 'PNG',
          width: png.info.width,
          height: png.info.height,
          quality: 100,
          buffer: png.data,
          ext: 'png',
          mimeType: 'image/png',
        });
        const webp = await resized
          .webp({ quality: Math.max(80, quality) })
          .toBuffer({ resolveWithObject: true });
        variants.push({
          kind: profile.kind,
          format: 'WEBP',
          width: webp.info.width,
          height: webp.info.height,
          quality: Math.max(80, quality),
          buffer: webp.data,
          ext: 'webp',
          mimeType: 'image/webp',
        });
        continue;
      }

      const webp = await resized
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      variants.push({
        kind: profile.kind,
        format: 'WEBP',
        width: webp.info.width,
        height: webp.info.height,
        quality,
        buffer: webp.data,
        ext: 'webp',
        mimeType: 'image/webp',
      });

      const jpegQuality =
        profile.jpegFallbackQuality ?? Math.min(90, quality + 2);
      const jpeg = await resized
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      variants.push({
        kind: profile.kind,
        format: 'JPEG',
        width: jpeg.info.width,
        height: jpeg.info.height,
        quality: jpegQuality,
        buffer: jpeg.data,
        ext: 'jpg',
        mimeType: 'image/jpeg',
      });
    }

    return variants;
  }

  async generatePreviewJpeg(
    sourceBuffer: Buffer,
    options: { maxWidth?: number; quality?: number; maxBytes?: number } = {},
  ): Promise<PreviewJpeg> {
    const buffer = await this.toDecodableImageBuffer(sourceBuffer);
    const probe = await this.probeImage(buffer);
    if (!probe.width || !probe.height) {
      throw new BadRequestException('Unable to detect image dimensions');
    }

    const maxWidth = Math.max(320, Math.min(options.maxWidth ?? 1200, 2048));
    const maxBytes =
      typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
        ? Math.max(100 * 1024, Math.min(options.maxBytes, 8 * 1024 * 1024))
        : undefined;
    const minQuality = 55;
    const minWidth = 720;
    let quality = Math.max(minQuality, Math.min(options.quality ?? 82, 90));
    let width = Math.min(maxWidth, probe.width);

    // Step quality down first (cheapest fidelity loss), then dimensions, until
    // the encoded JPEG fits under maxBytes. Mirrors the client-side
    // imagePreprocess loop for devices that cannot decode the file locally.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const resized = await sharp(buffer, { animated: false })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });

      if (!maxBytes || resized.data.length <= maxBytes || attempt === 7) {
        return {
          width: resized.info.width,
          height: resized.info.height,
          buffer: resized.data,
          mimeType: 'image/jpeg',
        };
      }

      if (quality > minQuality) {
        quality = Math.max(minQuality, quality - 8);
        continue;
      }
      const nextWidth = Math.round(width * 0.84);
      if (nextWidth < minWidth) {
        return {
          width: resized.info.width,
          height: resized.info.height,
          buffer: resized.data,
          mimeType: 'image/jpeg',
        };
      }
      width = nextWidth;
    }

    throw new BadRequestException('Unable to encode image preview');
  }

  private pickPrimaryFormat(
    mimeType: string,
    hasAlpha: boolean,
  ): 'AVIF' | 'PNG' | 'WEBP' {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('png') || hasAlpha) {
      return 'PNG';
    }
    if (normalized.includes('gif')) {
      return 'WEBP';
    }
    return 'AVIF';
  }
}
