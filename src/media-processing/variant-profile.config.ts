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
  avifQuality: number;
  jpegFallbackQuality?: number;
};

// Codec quality numbers use different scales. WebP is near-lossless (not its
// lossy 4:2:0 mode); AVIF is calibrated separately. Asset versions keep old URLs immutable.
export const IMAGE_VARIANT_PROFILES: VariantProfile[] = [
  { kind: 'AVATAR', maxWidth: 256, quality: 90, avifQuality: 75, jpegFallbackQuality: 96 },
  { kind: 'BANNER', maxWidth: 1920, quality: 92, avifQuality: 75, jpegFallbackQuality: 96 },
  { kind: 'THUMB', maxWidth: 240, quality: 90, avifQuality: 75, jpegFallbackQuality: 96 },
  { kind: 'CARD', maxWidth: 640, quality: 90, avifQuality: 75, jpegFallbackQuality: 96 },
  { kind: 'DETAIL', maxWidth: 1440, quality: 92, avifQuality: 75, jpegFallbackQuality: 96 },
  { kind: 'ZOOM', maxWidth: 2048, quality: 95, avifQuality: 80, jpegFallbackQuality: 98 },
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
