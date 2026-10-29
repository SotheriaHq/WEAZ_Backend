import { BadRequestException } from '@nestjs/common';
import type { Metadata, SharpOptions } from 'sharp';
import type sharpTypes from 'sharp';
import { createRequire } from 'node:module';
const sharp = createRequire(__filename)('sharp') as typeof sharpTypes;

export const SECURE_IMAGE_OPTIONS: SharpOptions = {
  animated: true,
  failOn: 'warning',
  limitInputPixels: 50_000_000,
  sequentialRead: true,
};

/** The budget covers all animation frames, not merely the first frame. */
export function assertSafeImageMetadata(metadata: Metadata): void {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  const pixels = width * (metadata.pageHeight ?? height) * pages;
  if (
    !['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'bmp'].includes(
      metadata.format ?? '',
    ) ||
    !Number.isSafeInteger(pixels) ||
    width <= 0 ||
    height <= 0 ||
    pixels > 50_000_000 ||
    pages > 200
  ) {
    throw new BadRequestException(
      'Image format or dimensions are not supported',
    );
  }
}

/** Decode every pixel without allocating a full raw output buffer or changing the original. */
export async function assertCompleteRasterImage(buffer: Buffer): Promise<void> {
  try {
    const image = sharp(buffer, SECURE_IMAGE_OPTIONS).timeout({ seconds: 10 });
    assertSafeImageMetadata(await image.metadata());
    await image.stats();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      'Image is corrupt, incomplete or exceeds processing limits',
    );
  }
}
