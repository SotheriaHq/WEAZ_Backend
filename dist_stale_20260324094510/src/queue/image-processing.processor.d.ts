import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { MediaProcessingService } from 'src/media-processing/media-processing.service';
import type { ImageProcessBatchJob, ImageProcessSingleJob } from './image-processing.queue.service';
export declare class ImageProcessingProcessor extends WorkerHost {
    private readonly prisma;
    private readonly uploadService;
    private readonly mediaProcessing;
    private readonly logger;
    constructor(prisma: PrismaService, uploadService: UploadService, mediaProcessing: MediaProcessingService);
    process(job: Job<ImageProcessSingleJob | ImageProcessBatchJob>): Promise<void>;
    private processOne;
}
