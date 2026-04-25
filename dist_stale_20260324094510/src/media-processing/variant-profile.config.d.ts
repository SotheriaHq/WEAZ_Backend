export type VariantKind = 'AVATAR' | 'BANNER' | 'THUMB' | 'CARD' | 'DETAIL' | 'ZOOM';
export type VariantProfile = {
    kind: VariantKind;
    maxWidth: number;
    quality: number;
    jpegFallbackQuality?: number;
};
export declare const IMAGE_VARIANT_PROFILES: VariantProfile[];
export declare const IMAGE_MIME_TYPES: Set<string>;
