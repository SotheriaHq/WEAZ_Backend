import { Injectable, BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
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

@Injectable()
export class MediaProcessingService {
  private readonly maxMegapixels = 50;

  isSupportedImageMime(mimeType: string): boolean {
    return IMAGE_MIME_TYPES.has(String(mimeType || '').toLowerCase());
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
    buffer: Buffer,
    options: { mimeType: string; textHeavy?: boolean },
  ): Promise<EncodedVariant[]> {
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
