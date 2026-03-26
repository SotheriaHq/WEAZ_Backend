"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMAGE_MIME_TYPES = exports.IMAGE_VARIANT_PROFILES = void 0;
exports.IMAGE_VARIANT_PROFILES = [
    { kind: 'AVATAR', maxWidth: 256, quality: 82, jpegFallbackQuality: 84 },
    { kind: 'BANNER', maxWidth: 1920, quality: 82, jpegFallbackQuality: 84 },
    { kind: 'THUMB', maxWidth: 240, quality: 74, jpegFallbackQuality: 76 },
    { kind: 'CARD', maxWidth: 640, quality: 78, jpegFallbackQuality: 80 },
    { kind: 'DETAIL', maxWidth: 1440, quality: 86, jpegFallbackQuality: 88 },
    { kind: 'ZOOM', maxWidth: 2048, quality: 90, jpegFallbackQuality: 92 },
];
exports.IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/heic',
    'image/heif',
]);
//# sourceMappingURL=variant-profile.config.js.map