import { type VariantKind } from './variant-profile.config';
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
export declare class MediaProcessingService {
    private readonly maxMegapixels;
    isSupportedImageMime(mimeType: string): boolean;
    probeImage(buffer: Buffer): Promise<ImageProbe>;
    generateVariants(buffer: Buffer, options: {
        mimeType: string;
        textHeavy?: boolean;
    }): Promise<EncodedVariant[]>;
    private pickPrimaryFormat;
}
