"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ImageProcessingProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageProcessingProcessor = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const crypto = require("crypto");
const prisma_service_1 = require("../prisma/prisma.service");
const upload_service_1 = require("../upload/upload.service");
const media_processing_service_1 = require("../media-processing/media-processing.service");
const queue_constants_1 = require("./queue.constants");
let ImageProcessingProcessor = ImageProcessingProcessor_1 = class ImageProcessingProcessor extends bullmq_1.WorkerHost {
    constructor(prisma, uploadService, mediaProcessing) {
        super();
        this.prisma = prisma;
        this.uploadService = uploadService;
        this.mediaProcessing = mediaProcessing;
        this.logger = new common_1.Logger(ImageProcessingProcessor_1.name);
    }
    async process(job) {
        if (job.name === queue_constants_1.IMAGE_PROCESS_SINGLE_JOB || job.name === queue_constants_1.IMAGE_REPROCESS_JOB) {
            const data = job.data;
            await this.processOne(data.fileId, Boolean(data.force));
            return;
        }
        if (job.name === queue_constants_1.IMAGE_PROCESS_BATCH_JOB) {
            const data = job.data;
            for (const fileId of data.fileIds || []) {
                await this.processOne(fileId, Boolean(data.force));
            }
        }
    }
    async processOne(fileId, force) {
        const file = await this.prisma.fileUpload.findUnique({ where: { id: fileId } });
        if (!file)
            return;
        const isImage = this.mediaProcessing.isSupportedImageMime(file.mimeType);
        if (!isImage) {
            await this.prisma.fileUpload.update({
                where: { id: fileId },
                data: { processingStatus: 'READY', processingError: null },
            });
            return;
        }
        if (!force && file.processingStatus === 'READY') {
            return;
        }
        try {
            await this.prisma.fileUpload.update({
                where: { id: fileId },
                data: { processingStatus: 'PENDING', processingError: null },
            });
            const originalBuffer = await this.uploadService.getObjectBufferByKey(file.s3Key);
            const probe = await this.mediaProcessing.probeImage(originalBuffer);
            const variants = await this.mediaProcessing.generateVariants(originalBuffer, {
                mimeType: file.mimeType,
            });
            const nextVersion = Number(file.assetVersion || 1);
            for (const variant of variants) {
                const key = this.uploadService.buildVariantS3Key({
                    variantKind: variant.kind,
                    fileId,
                    assetVersion: nextVersion,
                    ext: variant.ext,
                });
                const uploaded = await this.uploadService.putObjectBuffer({
                    key,
                    body: variant.buffer,
                    contentType: variant.mimeType,
                    isPublic: true,
                });
                await this.prisma.fileVariant.upsert({
                    where: {
                        fileUploadId_variantKind_format_assetVersion: {
                            fileUploadId: fileId,
                            variantKind: variant.kind,
                            format: variant.format,
                            assetVersion: nextVersion,
                        },
                    },
                    update: {
                        width: variant.width,
                        height: variant.height,
                        sizeBytes: variant.buffer.length,
                        quality: variant.quality,
                        s3Key: key,
                        s3Url: uploaded.url,
                    },
                    create: {
                        id: crypto.randomUUID(),
                        fileUploadId: fileId,
                        variantKind: variant.kind,
                        format: variant.format,
                        width: variant.width,
                        height: variant.height,
                        sizeBytes: variant.buffer.length,
                        quality: variant.quality,
                        s3Key: key,
                        s3Url: uploaded.url,
                        assetVersion: nextVersion,
                    },
                });
            }
            await this.prisma.fileUpload.update({
                where: { id: fileId },
                data: {
                    processingStatus: 'READY',
                    processingError: null,
                    width: probe.width,
                    height: probe.height,
                    hasAlpha: probe.hasAlpha,
                    isAnimated: probe.isAnimated,
                    orientation: probe.orientation,
                    colorSpace: probe.colorSpace,
                    lastProcessedAt: new Date(),
                },
            });
        }
        catch (error) {
            this.logger.error(`Image processing failed for ${fileId}: ${String(error)}`);
            await this.prisma.fileUpload.update({
                where: { id: fileId },
                data: {
                    processingStatus: 'FAILED',
                    processingError: String(error),
                },
            });
            throw error;
        }
    }
};
exports.ImageProcessingProcessor = ImageProcessingProcessor;
exports.ImageProcessingProcessor = ImageProcessingProcessor = ImageProcessingProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.IMAGE_PROCESSING_QUEUE),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        upload_service_1.UploadService,
        media_processing_service_1.MediaProcessingService])
], ImageProcessingProcessor);
//# sourceMappingURL=image-processing.processor.js.map