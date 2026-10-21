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

/**
 * Concurrency, measured rather than guessed.
 *
 * BullMQ's default is 1, so image jobs ran strictly one at a time. Measured on
 * SIT: 8 jobs drained in 90 seconds — **11.3s per job** for a 7.8KB PNG, with
 * the worker process sitting at ~0% CPU throughout. The time is not spent
 * resizing; it is spent waiting on S3, which is in a different region from the
 * box. A queue fed at 30 jobs/min against a 5 jobs/min ceiling backs up, which
 * is exactly what was observed.
 *
 * Work that is waiting on the network parallelises almost for free, so a small
 * concurrency multiplies throughput without multiplying CPU. It does not
 * multiply memory for free, though: `sharp` holds decoded bitmaps, and a real
 * user photo is megapixels rather than 64x64. On a 1.9GB host with ~314MB free
 * under load, 2 is the honest default — a meaningful gain with headroom left —
 * and the env var exists so a bigger box can raise it without a deploy.
 */
const IMAGE_PROCESSING_CONCURRENCY = Math.max(
  1,
  Number(process.env.IMAGE_PROCESSING_CONCURRENCY ?? 2) || 2,
);

@Processor(IMAGE_PROCESSING_QUEUE, {
  concurrency: IMAGE_PROCESSING_CONCURRENCY,
})
export class ImageProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly mediaProcessing: MediaProcessingService,
  ) {
    super();
  }

  async process(
    job: Job<ImageProcessSingleJob | ImageProcessBatchJob>,
  ): Promise<void> {
    if (
      job.name === IMAGE_PROCESS_SINGLE_JOB ||
      job.name === IMAGE_REPROCESS_JOB
    ) {
      const data = job.data as ImageProcessSingleJob;
      await this.processOne(
        data.fileId,
        Boolean(data.force),
        Boolean(data.newVersion),
      );
      return;
    }

    if (job.name === IMAGE_PROCESS_BATCH_JOB) {
      const data = job.data as ImageProcessBatchJob;
      for (const fileId of data.fileIds || []) {
        await this.processOne(
          fileId,
          Boolean(data.force),
          Boolean(data.newVersion),
        );
      }
    }
  }

  /**
   * `newVersion` re-encodes a file that already has variants, under the NEXT
   * asset version, for when the encoder settings change.
   *
   * It cannot overwrite in place: variant objects are served with a year-long
   * immutable Cache-Control through the Cloudflare edge, so rewritten bytes at
   * the same key would never reach a client. The new version's objects and
   * rows are written first, then the file is switched to it, then the older
   * version's ROWS are removed — several readers pick a variant by kind and
   * format without filtering on `assetVersion`, so leaving both would keep
   * serving the old one. The older objects are left in the bucket, because
   * clients still hold their URLs.
   *
   * A failure leaves a working photo exactly as it was: no FAILED status
   * (that drops it from the feed) and no throw (a batch retry would re-run
   * every file in the batch and bump the ones that had already succeeded).
   */
  private async processOne(
    fileId: string,
    force: boolean,
    newVersion = false,
  ): Promise<void> {
    const file = await this.prisma.fileUpload.findUnique({
      where: { id: fileId },
    });
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

    const reencode = newVersion && (file as any).processingStatus === 'READY';

    try {
      if (!reencode) {
        await this.prisma.fileUpload.update({
          where: { id: fileId },
          data: { processingError: null } as any,
        } as any);
      }

      const originalBuffer = await this.uploadService.getObjectBufferByKey(
        file.s3Key,
      );
      const probe = await this.mediaProcessing.probeImage(originalBuffer);
      const variants = this.mediaProcessing.generateVariantsIter(
        originalBuffer,
        {
          mimeType: file.mimeType,
        },
      );

      const currentVersion = Number((file as any).assetVersion || 1);
      const nextVersion = reencode ? currentVersion + 1 : currentVersion;
      for await (const variant of variants) {
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
          ...(reencode ? { assetVersion: nextVersion } : {}),
        } as any,
      } as any);

      if (reencode) {
        await (this.prisma as any).fileVariant.deleteMany({
          where: { fileUploadId: fileId, assetVersion: { lt: nextVersion } },
        });
      }
    } catch (error) {
      if (reencode) {
        this.logger.warn(
          `Image re-encode skipped for ${fileId}; current version kept: ${String(error)}`,
        );
        return;
      }
      this.logger.error(
        `Image processing failed for ${fileId}: ${String(error)}`,
      );
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
