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
  // DETAIL is the full-screen Runway image, so it is the byte cost of every
  // feed page. Width stays 1440: a landscape or square photo is contained
  // across the full screen width, and a 1440px-wide flagship would upscale
  // anything narrower. Quality 80 (was 86) measured ~20% smaller on real feed
  // photos (24-26% on the 1440px ones) with no visible change at phone size.
  { kind: 'DETAIL', maxWidth: 1440, quality: 80, jpegFallbackQuality: 82 },
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
