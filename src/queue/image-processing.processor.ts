import { Prisma, type FileUpload } from '@prisma/client';
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
      const failures: unknown[] = [];
      for (const fileId of data.fileIds || []) {
        try {
          await this.processOne(fileId, Boolean(data.force), Boolean(data.newVersion));
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Some legacy batch images failed; retained for retry');
    }
  }

  /** Durable per-file lease; expensive encoding never holds a database connection. */
  private async processOne(fileId: string, force: boolean, newVersion = false): Promise<void> {
    const initial = await this.prisma.fileUpload.findUnique({ where: { id: fileId } });
    if (!initial || (!force && !newVersion && initial.processingStatus === 'READY')) return;
    const token = crypto.randomUUID();
    const claim = await this.prisma.fileUpload.updateMany({
      where: { id: fileId, OR: [{ processingLeaseUntil: null }, { processingLeaseUntil: { lte: new Date() } }] },
      data: { processingLeaseToken: token, processingLeaseUntil: new Date(Date.now() + 10 * 60_000) },
    });
    if (!claim.count) return;
    let renewal: Promise<void> | undefined;
    let lostLease = false;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.prisma.fileUpload.updateMany({
        where: { id: fileId, processingLeaseToken: token },
        data: { processingLeaseUntil: new Date(Date.now() + 10 * 60_000) },
      }).then((result) => { if (!result.count) lostLease = true; })
        .catch(() => { lostLease = true; })
        .finally(() => { renewal = undefined; });
    }, 30_000);
    heartbeat.unref();
    try {
      const file = await this.prisma.fileUpload.findUnique({ where: { id: fileId } });
      if (file?.processingLeaseToken === token) {
        await this.processOwnedFile(file, token, force, newVersion, () => lostLease);
      }
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await this.prisma.fileUpload.updateMany({
        where: { id: fileId, processingLeaseToken: token },
        data: { processingLeaseToken: null, processingLeaseUntil: null },
      });
    }
  }

  private async processOwnedFile(file: FileUpload, token: string, force: boolean, newVersion: boolean, lostLease: () => boolean): Promise<void> {
    const fileId = file.id;
    if (!this.mediaProcessing.isSupportedImageMime(file.mimeType)) {
      await this.prisma.fileUpload.updateMany({
        where: { id: fileId, processingLeaseToken: token },
        data: { processingStatus: 'READY', processingError: null },
      });
      return;
    }
    // Any force on a published image uses new immutable URLs, even for legacy callers.
    const reencode = file.processingStatus === 'READY' && Boolean(file.lastProcessedAt) && (force || newVersion);
    const uploadedKeys: string[] = [];
    let published = false;
    try {
      const originalBuffer = await this.uploadService.getObjectBufferByKey(file.s3Key);
      const probe = await this.mediaProcessing.probeImage(originalBuffer);
      const variants = this.mediaProcessing.generateVariantsIter(originalBuffer, { mimeType: file.mimeType });
      const nextVersion = file.assetVersion + (reencode ? 1 : 0);
      const encoded: Prisma.FileVariantUncheckedCreateInput[] = [];
      for await (const variant of variants) {
        if (lostLease()) throw new Error('Image processing lease lost');
        const baseKey = this.uploadService.buildVariantS3Key({ variantKind: variant.kind, fileId, assetVersion: nextVersion, ext: variant.ext });
        // A stale encoder cannot overwrite another attempt's objects, including after lease expiry.
        const key = baseKey.replace(/\/([^/]+)$/, `/${token}/$1`);
        // Persist before uploading so a process crash or uncertain PUT response is recoverable.
        await this.prisma.storageObjectDeletion.createMany({ data: [{ s3Key: key,
          processingFileId: fileId, processingLeaseToken: token,
          nextAttemptAt: new Date(Date.now() + 86_400_000),
        }], skipDuplicates: true });
        const uploaded = await this.uploadService.putObjectBuffer({ key, body: variant.buffer, contentType: variant.mimeType });
        uploadedKeys.push(key);
        encoded.push({
          id: crypto.randomUUID(), fileUploadId: fileId, variantKind: variant.kind as any,
          format: variant.format as any, width: variant.width, height: variant.height,
          sizeBytes: variant.buffer.length, quality: variant.quality, s3Key: key, s3Url: uploaded.url,
          assetVersion: nextVersion,
        });
      }
      if (lostLease()) throw new Error('Image processing lease lost');
      published = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "_id" FROM "FileUpload" WHERE "_id"=${fileId}::uuid FOR UPDATE`;
        const owned = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "_id" AS id FROM "FileUpload" WHERE "_id"=${fileId}::uuid
          AND "processingLeaseToken"=${token}::uuid AND "processingLeaseUntil">(clock_timestamp() AT TIME ZONE 'UTC')
        `;
        if (!owned.length) return false;
        for (const variant of encoded) {
          await tx.fileVariant.upsert({
            where: { fileUploadId_variantKind_format_assetVersion: {
              fileUploadId: fileId, variantKind: variant.variantKind, format: variant.format, assetVersion: nextVersion,
            } },
            create: variant,
            update: { width: variant.width, height: variant.height, sizeBytes: variant.sizeBytes, quality: variant.quality, s3Key: variant.s3Key, s3Url: variant.s3Url },
          });
        }
        await tx.fileUpload.update({
          where: { id: fileId },
          data: {
            processingStatus: 'READY', processingError: null, width: probe.width, height: probe.height,
            hasAlpha: probe.hasAlpha, isAnimated: probe.isAnimated, orientation: probe.orientation,
            colorSpace: probe.colorSpace, lastProcessedAt: new Date(), assetVersion: nextVersion,
            processingLeaseToken: null, processingLeaseUntil: null,
          },
        });
        if (reencode) {
          // Existing issued URLs can live for up to seven days. Retire old objects after that window.
          await tx.$executeRaw`
            INSERT INTO "StorageObjectDeletion" ("s3Key", "nextAttemptAt")
            SELECT "s3Key", (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '8 days' FROM "FileVariant"
            WHERE "fileUploadId"=${fileId}::uuid AND "assetVersion" < ${nextVersion}
            ON CONFLICT ("s3Key") DO NOTHING
          `;
          await tx.fileVariant.deleteMany({ where: { fileUploadId: fileId, assetVersion: { lt: nextVersion } } });
        }
        if (uploadedKeys.length) await tx.storageObjectDeletion.deleteMany({
          where: { s3Key: { in: uploadedKeys }, processingLeaseToken: token },
        });
        return true;
      });
      if (!published) throw new Error('Image processing publish lease expired');
    } catch (error) {
      if (reencode) {
        this.logger.warn(`Image re-encode skipped for ${fileId}; current version kept: ${String(error)}`);
        throw error;
      }
      await this.prisma.fileUpload.updateMany({
        where: { id: fileId, processingLeaseToken: token },
        data: { processingStatus: 'FAILED', processingError: String(error) },
      });
      throw error;
    }
  }
}
