export type VariantKind =
  | 'AVATAR'
  | 'BANNER'
  | 'THUMB'
  | 'CARD'
  | 'DETAIL'
  | 'ZOOM';

export type VariantProfile = {
  kind: VariantKind;
  maxWidth: number;
  quality: number;
  jpegFallbackQuality?: number;
};

export const IMAGE_VARIANT_PROFILES: VariantProfile[] = [
  { kind: 'AVATAR', maxWidth: 256, quality: 82, jpegFallbackQuality: 84 },
  { kind: 'BANNER', maxWidth: 1920, quality: 82, jpegFallbackQuality: 84 },
  { kind: 'THUMB', maxWidth: 240, quality: 74, jpegFallbackQuality: 76 },
  { kind: 'CARD', maxWidth: 640, quality: 78, jpegFallbackQuality: 80 },
  // DETAIL is the full-screen Runway image. Quality is NOT traded for bytes
  // here: an experiment at 80 saved ~20% but softened photos visibly enough to
  // be reported, and the Cloudflare edge cache already removed most of the
  // transfer cost. Width stays 1440 so a 1440px-wide flagship never upscales.
  { kind: 'DETAIL', maxWidth: 1440, quality: 86, jpegFallbackQuality: 88 },
  { kind: 'ZOOM', maxWidth: 2048, quality: 90, jpegFallbackQuality: 92 },
];

export const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);
