"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaProcessingService = void 0;
const common_1 = require("@nestjs/common");
const sharp_1 = require("sharp");
const variant_profile_config_1 = require("./variant-profile.config");
let MediaProcessingService = class MediaProcessingService {
    constructor() {
        this.maxMegapixels = 50;
    }
    isSupportedImageMime(mimeType) {
        return variant_profile_config_1.IMAGE_MIME_TYPES.has(String(mimeType || '').toLowerCase());
    }
    async probeImage(buffer) {
        const metadata = await (0, sharp_1.default)(buffer, { animated: true }).metadata();
        const width = metadata.width ?? null;
        const height = metadata.height ?? null;
        if (width && height) {
            const megapixels = (width * height) / 1_000_000;
            if (megapixels > this.maxMegapixels) {
                throw new common_1.BadRequestException('Image dimensions are too large');
            }
        }
        return {
            width,
            height,
            hasAlpha: Boolean(metadata.hasAlpha),
            isAnimated: (metadata.pages ?? 1) > 1,
            orientation: typeof metadata.orientation === 'number' ? metadata.orientation : null,
            colorSpace: typeof metadata.space === 'string' ? metadata.space : null,
            format: typeof metadata.format === 'string' ? metadata.format : null,
        };
    }
    async generateVariants(buffer, options) {
        const probe = await this.probeImage(buffer);
        if (!probe.width || !probe.height) {
            throw new common_1.BadRequestException('Unable to detect image dimensions');
        }
        if (probe.isAnimated) {
            return [];
        }
        const variants = [];
        const outputFormat = this.pickPrimaryFormat(options.mimeType, probe.hasAlpha);
        for (const profile of variant_profile_config_1.IMAGE_VARIANT_PROFILES) {
            const resized = (0, sharp_1.default)(buffer, { animated: false }).rotate().resize({
                width: Math.min(profile.maxWidth, probe.width),
                withoutEnlargement: true,
            });
            const qualityBump = options.textHeavy ? 4 : 0;
            const quality = Math.min(95, profile.quality + qualityBump);
            if (outputFormat === 'AVIF') {
                const out = await resized.avif({ quality }).toBuffer({ resolveWithObject: true });
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
                const webp = await resized.webp({ quality: Math.max(68, quality - 4) }).toBuffer({ resolveWithObject: true });
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
                const png = await resized.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
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
                const webp = await resized.webp({ quality: Math.max(80, quality) }).toBuffer({ resolveWithObject: true });
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
            const webp = await resized.webp({ quality }).toBuffer({ resolveWithObject: true });
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
            const jpegQuality = profile.jpegFallbackQuality ?? Math.min(90, quality + 2);
            const jpeg = await resized.jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
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
    pickPrimaryFormat(mimeType, hasAlpha) {
        const normalized = String(mimeType || '').toLowerCase();
        if (normalized.includes('png') || hasAlpha) {
            return 'PNG';
        }
        if (normalized.includes('gif')) {
            return 'WEBP';
        }
        return 'AVIF';
    }
};
exports.MediaProcessingService = MediaProcessingService;
exports.MediaProcessingService = MediaProcessingService = __decorate([
    (0, common_1.Injectable)()
], MediaProcessingService);
//# sourceMappingURL=media-processing.service.js.map