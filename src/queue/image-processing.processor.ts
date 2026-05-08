import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { MediaProcessingService } from 'src/media-processing/media-processing.service';
import {
  IMAGE_PROCESSING_QUEUE,
  IMAGE_PROCESS_SINGLE_JOB,
  IMAGE_PROCESS_BATCH_JOB,
  IMAGE_REPROCESS_JOB,
} from './queue.constants';
import type {
  ImageProcessBatchJob,
  ImageProcessSingleJob,
} from './image-processing.queue.service';

@Processor(IMAGE_PROCESSING_QUEUE)
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly mediaProcessing: MediaProcessingService,
  ) {
    super();
  }

  async process(job: Job<ImageProcessSingleJob | ImageProcessBatchJob>): Promise<void> {
    if (job.name === IMAGE_PROCESS_SINGLE_JOB || job.name === IMAGE_REPROCESS_JOB) {
      const data = job.data as ImageProcessSingleJob;
      await this.processOne(data.fileId, Boolean(data.force));
      return;
    }

    if (job.name === IMAGE_PROCESS_BATCH_JOB) {
      const data = job.data as ImageProcessBatchJob;
      for (const fileId of data.fileIds || []) {
        await this.processOne(fileId, Boolean(data.force));
      }
    }
  }

  private async processOne(fileId: string, force: boolean): Promise<void> {
    const file = await this.prisma.fileUpload.findUnique({ where: { id: fileId } });
    if (!file) return;

    const isImage = this.mediaProcessing.isSupportedImageMime(file.mimeType);
    if (!isImage) {
      await this.prisma.fileUpload.update({
        where: { id: fileId },
        data: { processingStatus: 'READY', processingError: null } as any,
      } as any);
      return;
    }

    if (!force && (file as any).processingStatus === 'READY') {
      return;
    }

    try {
      await this.prisma.fileUpload.update({
        where: { id: fileId },
        data: { processingError: null } as any,
      } as any);

      const originalBuffer = await this.uploadService.getObjectBufferByKey(file.s3Key);
      const probe = await this.mediaProcessing.probeImage(originalBuffer);
      const variants = await this.mediaProcessing.generateVariants(originalBuffer, {
        mimeType: file.mimeType,
      });

      const nextVersion = Number((file as any).assetVersion || 1);
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

        await (this.prisma as any).fileVariant.upsert({
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
        } as any,
      } as any);
    } catch (error) {
      this.logger.error(`Image processing failed for ${fileId}: ${String(error)}`);
      await this.prisma.fileUpload.update({
        where: { id: fileId },
        data: {
          processingStatus: 'FAILED',
          processingError: String(error),
        } as any,
      } as any);
      throw error;
    }
  }
}
