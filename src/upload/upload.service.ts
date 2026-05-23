import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FileUpload } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { v4 as uuidv4 } from 'uuid';
import { GetFilesDto } from './dto/get-files.dto';
import { PaginatedResult } from './dto/pagination.dto';
import { ConfigService } from '@nestjs/config';
import { FileType } from './upload.enums';
import * as path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';

type VariantView = {
  url: string;
  width: number;
  height: number;
  format: string;
};

type VariantsMap = {
  thumb?: VariantView;
  card?: VariantView;
  detail?: VariantView;
  zoom?: VariantView;
  avatar?: VariantView;
  banner?: VariantView;
};

export interface FileUploadResult {
  id: string;
  url: string;
  key: string;
  fileName: string;
  originalName: string;
  size: number;
  mimeType: string;
  fileType: FileType;
  processingStatus?: 'PENDING' | 'READY' | 'FAILED';
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3: S3Client;
  private readonly bucketName: string;
  private readonly region: string;

  private summarizeAwsError(error: unknown): {
    name?: string;
    message?: string;
    code?: string;
    httpStatusCode?: number;
    requestId?: string;
  } {
    const anyErr = error as any;
    return {
      name: typeof anyErr?.name === 'string' ? anyErr.name : undefined,
      message:
        typeof anyErr?.message === 'string' ? anyErr.message : undefined,
      code:
        typeof anyErr?.code === 'string'
          ? anyErr.code
          : typeof anyErr?.Code === 'string'
            ? anyErr.Code
            : undefined,
      httpStatusCode:
        typeof anyErr?.$metadata?.httpStatusCode === 'number'
          ? anyErr.$metadata.httpStatusCode
          : undefined,
      requestId:
        typeof anyErr?.$metadata?.requestId === 'string'
          ? anyErr.$metadata.requestId
          : undefined,
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly systemConfigService: SystemConfigService,
    @Optional()
    private readonly imageQueue?: ImageProcessingQueueService,
  ) {
    this.bucketName =
      this.configService.get<string>('AWS_S3_BUCKET') ??
      this.configService.get<string>('S3_BUCKET');

    if (!this.bucketName) {
      throw new Error('AWS_S3_BUCKET (or S3_BUCKET) must be configured.');
    }

    this.region =
      this.configService.get<string>('AWS_REGION') ??
      this.configService.get<string>('REGION') ??
      'eu-north-1';

    const accessKeyId =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ??
      this.configService.get<string>('ACCESS_KEY_ID');

    const secretAccessKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ??
      this.configService.get<string>('SECRET_ACCESS_KEY');

    const s3Config: any = {
      region: this.region,
    };

    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = {
        accessKeyId,
        secretAccessKey,
      };
    }

    this.s3 = new S3Client(s3Config);
  }

  private encodeS3KeyForUrl(key: string): string {
    return String(key)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private buildS3ObjectUrl(key: string): string {
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${this.encodeS3KeyForUrl(key)}`;
  }

  private buildS3BucketUrl(): string {
    return `https://${this.bucketName}.s3.${this.region}.amazonaws.com`;
  }

  private isTruthyConfig(value?: string | null): boolean {
    return ['1', 'true', 'yes', 'on', 'public'].includes(
      String(value ?? '').trim().toLowerCase(),
    );
  }

  private isRawS3ObjectUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.hostname.toLowerCase().includes('amazonaws.com');
    } catch {
      return false;
    }
  }

  private isBucketPublicForDisplay(): boolean {
    return (
      this.isTruthyConfig(this.configService.get<string>('MEDIA_BUCKET_PUBLIC')) ||
      this.isTruthyConfig(this.configService.get<string>('S3_BUCKET_PUBLIC')) ||
      this.isTruthyConfig(this.configService.get<string>('AWS_S3_BUCKET_PUBLIC')) ||
      this.isTruthyConfig(this.configService.get<string>('S3_PUBLIC_READ')) ||
      this.isTruthyConfig(this.configService.get<string>('MEDIA_OBJECTS_PUBLIC'))
    );
  }

  private getConfiguredPublicBaseUrl(): string | null {
    const configuredBase =
      this.configService.get<string>('MEDIA_PUBLIC_BASE_URL') ??
      this.configService.get<string>('CDN_PUBLIC_BASE_URL') ??
      this.configService.get<string>('CLOUDFRONT_PUBLIC_BASE_URL') ??
      this.configService.get<string>('CLOUDFRONT_URL');
    return configuredBase?.trim().replace(/\/+$/, '') || null;
  }

  private getStablePublicDisplayUrl(file: { s3Url?: string | null; s3Key?: string | null }): string | null {
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    const publicBase = this.getConfiguredPublicBaseUrl();

    if (publicBase && key) {
      return `${publicBase}/${this.encodeS3KeyForUrl(key)}`;
    }

    const directUrl = typeof file.s3Url === 'string' ? file.s3Url.trim() : '';
    if (directUrl && !this.isRawS3ObjectUrl(directUrl)) {
      return directUrl;
    }

    return null;
  }

  getPublicDisplayUrl(file: { s3Url?: string | null; s3Key?: string | null; isPublic?: boolean | null }): string | null {
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    const publicBase = this.getConfiguredPublicBaseUrl();

    if (publicBase && key) {
      return `${publicBase}/${this.encodeS3KeyForUrl(key)}`;
    }

    const directUrl = typeof file.s3Url === 'string' ? file.s3Url.trim() : '';
    if (!directUrl) return null;

    if (!this.isRawS3ObjectUrl(directUrl)) {
      return directUrl;
    }

    if (file.isPublic || this.isBucketPublicForDisplay()) {
      return key ? this.buildS3ObjectUrl(key) : directUrl;
    }

    return null;
  }

  async getTemporarySignedDisplayUrl(
    file: { id?: string | null; s3Key?: string | null },
    expiresIn = 15 * 60,
  ): Promise<string | null> {
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    if (!key) return null;

    const nodeEnv = String(this.configService.get<string>('NODE_ENV') ?? '').toLowerCase();
    if (nodeEnv !== 'production') {
      this.logger.warn(
        `[media] temporary signed display URL fallback used fileId=${file.id ?? 'unknown'} expiresIn=${expiresIn}; configure MEDIA_PUBLIC_BASE_URL/CDN_PUBLIC_BASE_URL/CLOUDFRONT_URL for production public feed media.`,
      );
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return await getSignedUrl(this.s3, command, { expiresIn });
  }

  private isReadyStoredFile(file: any): boolean {
    return Boolean(
      file &&
        !file.originalDeletedAt &&
        file.processingStatus === 'READY' &&
        typeof file.s3Key === 'string' &&
        file.s3Key.trim().length > 0,
    );
  }

  private isPublicCollectionFile(file: any): boolean {
    const medias = Array.isArray(file?.collectionMedias)
      ? file.collectionMedias
      : [];

    return medias.some((media: any) => {
      const collection = media?.collection;
      return Boolean(
        collection &&
          collection.status === 'PUBLISHED' &&
          collection.visibility === 'PUBLIC' &&
          !collection.deletedAt,
      );
    });
  }

  private isPublicIdentityFile(file: any): boolean {
    const profileImages = Array.isArray(file?.userProfileImages)
      ? file.userProfileImages
      : [];
    const profileBanners = Array.isArray(file?.userProfileBanners)
      ? file.userProfileBanners
      : [];

    return profileImages.length > 0 || profileBanners.length > 0;
  }

  private canReturnPublicFileUrl(file: any): boolean {
    if (!this.isReadyStoredFile(file)) return false;
    return Boolean(
      file.isPublic ||
      this.isPublicCollectionFile(file) ||
      this.isPublicIdentityFile(file),
    );
  }

  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    fileType: FileType,
  ): Promise<FileUploadResult> {
    await this.validateFile(file, fileType);

    const fileId = uuidv4();
    const key = this.generateS3Key(fileType, userId, fileId, file.originalname);

    const nodeEnv = (this.configService.get<string>('NODE_ENV') ?? '').trim();
    const isProduction = nodeEnv.toLowerCase() === 'production';

    try {
      this.logger.debug(
        `Uploading file to S3 bucket ${this.bucketName} with key ${key}`,
      );
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentDisposition: 'inline',
      });

      await this.s3.send(command);

      // Construct S3 URL
      const s3Url = this.buildS3ObjectUrl(key);

      // Save to database
      const uploadRecord = await this.prisma.fileUpload.create({
        data: {
          id: fileId,
          userId,
          originalName: file.originalname,
          fileName: key.split('/').pop()!,
          s3Key: key,
          s3Url: s3Url,
          fileType: fileType,
          mimeType: file.mimetype,
          size: file.size,
          processingStatus: 'READY',
        } as any,
      });

      await this.enqueueImageProcessing(uploadRecord.id, true);

      return {
        id: uploadRecord.id,
        url: uploadRecord.s3Url,
        key: uploadRecord.s3Key,
        fileName: uploadRecord.fileName,
        originalName: uploadRecord.originalName,
        size: uploadRecord.size,
        mimeType: uploadRecord.mimeType,
        fileType: uploadRecord.fileType as FileType,
        processingStatus: (uploadRecord as any).processingStatus,
        createdAt: uploadRecord.createdAt.toISOString(),
        updatedAt: uploadRecord.updatedAt.toISOString(),
      };
    } catch (error) {
      const details = this.summarizeAwsError(error);
      this.logger.error(
        `S3 file upload failed (${details.name ?? 'UnknownError'}): ${details.message ?? ''}`,
        details as any,
      );

      // Dev fallback: if S3 isn't configured/available locally, still allow uploads
      // by writing to disk under the API's /uploads static route.
      if (!isProduction) {
        this.logger.warn(
          'Falling back to local disk upload (non-production).',
        );
        return this.uploadFileToLocalDisk(file, userId, fileType, fileId, key);
      }

      throw new BadRequestException('File upload failed');
    }
  }

  private getLocalPublicBaseUrl(): string {
    const explicit =
      this.configService.get<string>('APP_PUBLIC_URL') ??
      this.configService.get<string>('PUBLIC_BASE_URL') ??
      this.configService.get<string>('APP_URL');

    if (explicit && explicit.trim().length > 0) {
      return explicit.trim().replace(/\/+$/, '');
    }

    const port = this.configService.get<string>('APP_PORT') ?? '3040';
    return `http://localhost:${port}`;
  }

  private isProductionRuntime(): boolean {
    return (
      String(this.configService.get<string>('NODE_ENV') ?? '')
        .trim()
        .toLowerCase() === 'production'
    );
  }

  private isPrivateNetworkHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    if (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '0.0.0.0' ||
      normalized === '::1' ||
      normalized.startsWith('10.') ||
      normalized.startsWith('192.168.')
    ) {
      return true;
    }

    const match = normalized.match(/^172\.(\d{1,2})\./);
    if (!match) return false;
    const secondOctet = Number(match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  private getLocalDevSignedDisplayUrl(file: { s3Url?: string | null }): string | null {
    if (this.isProductionRuntime()) return null;

    const directUrl = typeof file.s3Url === 'string' ? file.s3Url.trim() : '';
    if (!directUrl) return null;

    try {
      const parsed = new URL(directUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      if (!parsed.pathname.startsWith('/uploads/')) return null;
      if (!this.isPrivateNetworkHost(parsed.hostname)) return null;
      return directUrl;
    } catch {
      return null;
    }
  }

  private async uploadFileToLocalDisk(
    file: Express.Multer.File,
    userId: string,
    fileType: FileType,
    fileId: string,
    key: string,
  ): Promise<FileUploadResult> {
    const uploadsRoot = path.join(process.cwd(), 'uploads');
    const diskPath = path.join(uploadsRoot, key);
    const diskDir = path.dirname(diskPath);

    await mkdir(diskDir, { recursive: true });
    await writeFile(diskPath, file.buffer);

    const baseUrl = this.getLocalPublicBaseUrl();
    const publicUrl = `${baseUrl}/uploads/${key.split(path.sep).join('/')}`;

    const uploadRecord = await this.prisma.fileUpload.create({
      data: {
        id: fileId,
        userId,
        originalName: file.originalname,
        fileName: key.split('/').pop()!,
        s3Key: key,
        s3Url: publicUrl,
        fileType: fileType,
        mimeType: file.mimetype,
        size: file.size,
        processingStatus: 'READY',
      } as any,
    });

    await this.enqueueImageProcessing(uploadRecord.id, true);

    return {
      id: uploadRecord.id,
      url: uploadRecord.s3Url,
      key: uploadRecord.s3Key,
      fileName: uploadRecord.fileName,
      originalName: uploadRecord.originalName,
      size: uploadRecord.size,
      mimeType: uploadRecord.mimeType,
      fileType: uploadRecord.fileType as FileType,
      processingStatus: (uploadRecord as any).processingStatus,
      createdAt: uploadRecord.createdAt.toISOString(),
      updatedAt: uploadRecord.updatedAt.toISOString(),
    };
  }

  // Generate presigned POST data for client direct-to-S3 uploads
  async createPresignedPost(
    userId: string,
    originalName: string,
    fileType: FileType,
    contentType?: string,
    options?: { collectionId?: string; orderIndex?: number },
  ) {
    // create presigned post and persist a pending PresignedUpload record
    const fileId = uuidv4();
    const key = this.generateS3Key(fileType, userId, fileId, originalName);

    // Build fields and conditions for AWS v3 createPresignedPost
    const baseConditions: any[] = [];
    let fields: Record<string, string> = { key };

    if (contentType) {
      fields = {
        ...fields,
        'Content-Type': contentType,
      };
      baseConditions.push(['eq', '$Content-Type', contentType]);
    } else {
      baseConditions.push(['starts-with', '$Content-Type', '']);
    }

    // create DB presign record
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await (this.prisma as any)['presignedUpload'].create({
      data: {
        id: fileId,
        userId,
        collectionId: options?.collectionId,
        orderIndex: typeof options?.orderIndex === 'number' ? options.orderIndex : null,
        originalName,
        contentType: '',
        fileType,
        s3Key: key,
        expiresAt,
      },
    } as any);

    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucketName,
      Key: key,
      Fields: fields,
      Conditions: baseConditions,
      Expires: 600, // seconds
    });

    // Build a region-specific upload URL to avoid region-signature mismatches
    const uploadUrl = this.buildS3BucketUrl();

    return {
      ...presigned,
      url: uploadUrl,
      key,
      fileId,
      expiresIn: 600,
    } as any;
  }

  async updateUserProfileImage(
    userId: string,
    file: Pick<FileUploadResult, 'id' | 'url'>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          userProfile: { select: { firstName: true, lastName: true } },
        },
      });
      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          firstName: user?.userProfile?.firstName ?? '',
          lastName: user?.userProfile?.lastName ?? '',
          profileImageId: file.id,
          profileImage: file.url,
        },
        update: { profileImageId: file.id, profileImage: file.url },
      });
      // Strict sync: store logo mirrors brand profile image.
      await tx.brand.updateMany({
        where: { ownerId: userId },
        data: { logo: file.url },
      });
    });
  }

  async clearUserProfileImage(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          userProfile: { select: { firstName: true, lastName: true } },
        },
      });
      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          firstName: user?.userProfile?.firstName ?? '',
          lastName: user?.userProfile?.lastName ?? '',
          profileImageId: null,
          profileImage: null,
        },
        update: { profileImageId: null, profileImage: null },
      });
      // Strict sync: store logo mirrors brand profile image.
      await tx.brand.updateMany({
        where: { ownerId: userId },
        data: { logo: null },
      });
    });
  }

  async updateUserBannerImage(
    userId: string,
    file: Pick<FileUploadResult, 'id' | 'url'>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          userProfile: { select: { firstName: true, lastName: true } },
        },
      });
      await tx.userProfile.upsert({
        where: { userId },
        create: {
          userId,
          firstName: user?.userProfile?.firstName ?? '',
          lastName: user?.userProfile?.lastName ?? '',
          bannerImageId: file.id,
          bannerImage: file.url,
        },
        update: { bannerImageId: file.id, bannerImage: file.url },
      });
      // Strict sync: store banner mirrors brand banner image.
      await tx.brand.updateMany({
        where: { ownerId: userId },
        data: { banner: file.url },
      });
    });
  }

  async getUserFiles(
    userId: string,
    { cursor, limit = 20, type: fileType }: GetFilesDto,
  ): Promise<PaginatedResult<FileUpload>> {
    // Fetch one extra item to determine if there are more items
    const items = await this.prisma.fileUpload.findMany({
      where: {
        userId,
        ...(fileType && { fileType }),
        ...(cursor && {
          createdAt: {
            lt: new Date(cursor), // Less than the cursor (previous items)
          },
        }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1, // Take one extra to determine if there are more items
    });

    const hasNextPage = items.length > limit;
    const data = hasNextPage ? items.slice(0, -1) : items;
    const endCursor =
      data.length > 0 ? data[data.length - 1].createdAt.toISOString() : null;

    return {
      items: data,
      hasNextPage,
      endCursor,
    };
  }

  async getSignedUrl(fileId: string, userId: string): Promise<string> {
    const file = await this.prisma.fileUpload.findFirst({
      where: { id: fileId, userId },
    });

    if (!file) {
      throw new BadRequestException('File not found');
    }
    if (!this.isReadyStoredFile(file)) {
      this.logger.warn(`[media] signed-url denied for unavailable file fileId=${fileId}`);
      throw new BadRequestException('File not available');
    }

    const localDevUrl = this.getLocalDevSignedDisplayUrl(file);
    if (localDevUrl) {
      return localDevUrl;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: file.s3Key,
    });

    return await getSignedUrl(this.s3, command, { expiresIn: 3600 }); // 1 hour
  }

  /**
   * Get signed URL for public access (no ownership check)
   * Used for published collection media and public profile images
   */
  async getPublicSignedUrl(fileId: string): Promise<string | null> {
    const file = await this.prisma.fileUpload.findUnique({
      where: { id: fileId },
      include: {
        collectionMedias: {
          include: {
            collection: {
              select: {
                id: true,
                status: true,
                visibility: true,
                deletedAt: true,
              },
            },
          },
        },
        userProfileImages: {
          select: { id: true },
        },
        userProfileBanners: {
          select: { id: true },
        },
      } as any,
    });

    if (!file || !this.canReturnPublicFileUrl(file)) {
      this.logger.warn(`[media] public-url denied fileId=${fileId}`);
      return null;
    }

    const stablePublicUrl = this.getStablePublicDisplayUrl(file);
    if (stablePublicUrl) {
      return stablePublicUrl;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: file.s3Key,
    });

    return await getSignedUrl(this.s3, command, { expiresIn: 3600 }); // 1 hour
  }

  /**
   * Get signed URL by raw S3 key (no DB lookup required).
   * Used when the frontend only has a raw S3 URL and needs a signed version.
   */
  async getPublicSignedUrlByKey(s3Key: string): Promise<string | null> {
    const normalizedKey = typeof s3Key === 'string' ? s3Key.trim() : '';
    if (!normalizedKey || normalizedKey.includes('..')) {
      throw new BadRequestException('Invalid S3 key');
    }

    const directFile = await this.prisma.fileUpload.findUnique({
      where: { s3Key: normalizedKey },
      include: {
        collectionMedias: {
          include: {
            collection: {
              select: {
                id: true,
                status: true,
                visibility: true,
                deletedAt: true,
              },
            },
          },
        },
        userProfileImages: {
          select: { id: true },
        },
        userProfileBanners: {
          select: { id: true },
        },
      } as any,
    } as any);

    const variant = directFile
      ? null
      : await (this.prisma as any).fileVariant.findFirst({
          where: { s3Key: normalizedKey },
          include: {
            file: {
              include: {
                collectionMedias: {
                  include: {
                    collection: {
                      select: {
                        id: true,
                        status: true,
                        visibility: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
                userProfileImages: {
                  select: { id: true },
                },
                userProfileBanners: {
                  select: { id: true },
                },
              },
            },
          },
        });

    const sourceFile = directFile ?? variant?.file ?? null;
    if (!sourceFile || !this.canReturnPublicFileUrl(sourceFile)) {
      this.logger.warn('[media] public-url-by-key denied');
      return null;
    }

    const stablePublicUrl = this.getStablePublicDisplayUrl({
      s3Key: normalizedKey,
      s3Url: directFile?.s3Url,
    });
    if (stablePublicUrl) {
      return stablePublicUrl;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: normalizedKey,
    });

    return await getSignedUrl(this.s3, command, { expiresIn: 3600 }); // 1 hour
  }

  /**
   * Batch generate signed URLs for multiple files (optimized for feeds)
   */
  async getBatchPublicSignedUrls(
    fileIds: string[],
  ): Promise<Map<string, string>> {
    if (!fileIds || fileIds.length === 0) {
      return new Map<string, string>();
    }
    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, s3Key: true, s3Url: true },
    });

    const urlMap = new Map<string, string>();

    const chunkSize = 25;
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (file) => {
          const stablePublicUrl = this.getStablePublicDisplayUrl(file);
          if (stablePublicUrl) {
            return [file.id, stablePublicUrl] as const;
          }

          const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: file.s3Key,
          });
          const signedUrl = await getSignedUrl(this.s3, command, {
            expiresIn: 3600,
          }); // 1 hour
          return [file.id, signedUrl] as const;
        }),
      );
      for (const [id, url] of results) {
        urlMap.set(id, url);
      }
    }

    return urlMap;
  }

  async deleteFile(fileId: string, userId: string): Promise<void> {
    const file = await this.prisma.fileUpload.findFirst({
      where: { id: fileId, userId },
    });

    if (!file) {
      throw new BadRequestException('File not found');
    }

    try {
      // Delete from S3
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: file.s3Key,
      });
      await this.s3.send(command);

      // Delete from database
      await this.prisma.fileUpload.delete({
        where: { id: fileId },
      });
    } catch (error) {
      this.logger.error('File deletion failed:', error);
      throw new BadRequestException('File deletion failed');
    }
  }

  /**
   * Delete a single S3 object by key (does not touch DB)
   */
  async deleteS3ObjectByKey(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3.send(command);
    } catch (err) {
      this.logger.error('S3 deleteObject failed for key:', key, err);
      throw err;
    }
  }

  /**
   * Delete multiple S3 objects by keys in a single request.
   */
  async deleteS3ObjectsByKeys(keys: string[]): Promise<void> {
    if (!keys || keys.length === 0) return;
    const objects = keys.map((k) => ({ Key: k }));
    try {
      // AWS SDK deleteObjects returns details about deleted vs errors
      const command = new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: { Objects: objects },
      });

      const res = await this.s3.send(command);

      if (res.Errors && res.Errors.length) {
        this.logger.error('S3 deleteObjects reported errors', res.Errors);
        throw new Error('One or more S3 deletions failed');
      }
    } catch (err) {
      this.logger.error('S3 deleteObjects failed:', err);
      throw err;
    }
  }

  // Verify S3 object exists by key
  async verifyObjectExists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3.send(command);
      return true;
    } catch (err) {
      const details = this.summarizeAwsError(err);
      const errorCode = String(details.code ?? '').toUpperCase();
      const errorName = String(details.name ?? '').toUpperCase();
      const statusCode = details.httpStatusCode;
      const message = String(details.message ?? '').toUpperCase();

      const isNotFound =
        statusCode === 404 ||
        errorCode === 'NOTFOUND' ||
        errorCode === 'NOSUCHKEY' ||
        errorName === 'NOTFOUND' ||
        errorName === 'NOSUCHKEY' ||
        message.includes('NOT FOUND') ||
        message.includes('NO SUCH KEY');

      if (isNotFound) {
        this.logger.warn('S3 object was not found for key:', key);
        return false;
      }

      this.logger.error('S3 headObject failed for key:', key, details as any);
      throw new ServiceUnavailableException(
        'Storage is temporarily unavailable. Please retry in a moment.',
      );
    }
  }

  // Create a FileUpload DB record after presigned upload
  async createFileRecordFromPresign(
    id: string,
    userId: string,
    key: string,
    mimeType: string,
    size: number,
    originalId?: string,
  ) {
    // Look up presign record to get originalName and fileType
    const presign = await (this.prisma as any)['presignedUpload'].findUnique({
      where: { id },
    } as any);
    if (!presign) {
      throw new BadRequestException('Presign record not found');
    }

    if (presign.userId !== userId) {
      throw new ForbiddenException('Presign record does not belong to user');
    }

    if (presign.s3Key !== key) {
      throw new BadRequestException('S3 key mismatch for presign record');
    }

    const now = new Date();
    if (presign.expiresAt && presign.expiresAt < now) {
      await (this.prisma as any)['presignedUpload'].update({
        where: { id },
        data: { status: 'EXPIRED' },
      } as any);
      throw new BadRequestException('Presign has expired');
    }

    if (presign.status === 'USED') {
      const existing = await this.prisma.fileUpload.findUnique({
        where: { id },
      });
      if (existing) return existing;
      throw new BadRequestException('Presign already used');
    }

    if (presign.status === 'EXPIRED') {
      throw new BadRequestException('Presign has expired');
    }

    if (presign.status !== 'PENDING' && presign.status !== 'READY') {
      throw new BadRequestException('Presign is not ready for use');
    }

    // Mark presign as USED
    await (this.prisma as any)['presignedUpload'].update({
      where: { id },
      data: { status: 'USED', finalizedAt: new Date() },
    } as any);

    const fileName = key.split('/').pop() || key;
    const url = this.buildS3ObjectUrl(key);

    const record = await this.prisma.fileUpload.create({
      data: {
        id: id,
        userId,
        originalName: presign.originalName || originalId || fileName,
        fileName,
        s3Key: key,
        s3Url: url,
        fileType: presign.fileType as any,
        mimeType,
        size: size || 0,
        processingStatus: 'READY',
      } as any,
    });

    await this.enqueueImageProcessing(record.id, true);

    return record;
  }

  // Helper for server-side tests: upload a buffer directly to S3 and create FileUpload record
  async uploadBufferDirect(
    userId: string,
    originalName: string,
    buffer: Buffer,
    mimeType: string,
    fileType: FileType,
  ) {
    const fileId = uuidv4();
    const key = this.generateS3Key(fileType, userId, fileId, originalName);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });

    await this.s3.send(command);

    // Construct S3 URL
    const s3Url = this.buildS3ObjectUrl(key);

    const record = await this.prisma.fileUpload.create({
      data: {
        id: fileId,
        userId,
        originalName,
        fileName: key.split('/').pop()!,
        s3Key: key,
        s3Url: s3Url,
        fileType,
        mimeType,
        size: buffer.length,
        processingStatus: 'READY',
      } as any,
    });
    await this.enqueueImageProcessing(record.id, true);
    return record;
  }

  async getFileVariants(fileId: string, userId?: string) {
    const file = await this.prisma.fileUpload.findFirst({
      where: userId ? { id: fileId, userId } : { id: fileId },
    });
    if (!file) {
      throw new BadRequestException('File not found');
    }

    const variantRows = await (this.prisma as any).fileVariant.findMany({
      where: { fileUploadId: fileId, assetVersion: (file as any).assetVersion ?? 1 },
      orderBy: [{ variantKind: 'asc' }, { format: 'asc' }],
    });

    const variants: VariantsMap = {};
    for (const row of variantRows ?? []) {
      const key = String((row.variantKind || '')).toLowerCase();
      const mapped =
        key === 'thumb' ||
        key === 'card' ||
        key === 'detail' ||
        key === 'zoom' ||
        key === 'avatar' ||
        key === 'banner'
          ? key
          : null;
      if (!mapped) continue;
      if ((variants as any)[mapped]) continue;
      (variants as any)[mapped] = {
        url: row.s3Url,
        width: row.width,
        height: row.height,
        format: row.format,
      } as VariantView;
    }

    return {
      fileId: file.id,
      processingStatus: (file as any).processingStatus ?? 'READY',
      version: (file as any).assetVersion ?? 1,
      variants,
      fallbackUrl: file.s3Url,
      s3Url: file.s3Url,
    };
  }

  async reprocessFile(fileId: string, userId: string) {
    const file = await this.prisma.fileUpload.findFirst({
      where: { id: fileId, userId },
      select: { id: true },
    });
    if (!file) {
      throw new BadRequestException('File not found');
    }

    await this.prisma.fileUpload.update({
      where: { id: fileId },
      data: {
        processingStatus: 'PENDING',
        processingError: null,
      } as any,
    } as any);

    await this.enqueueImageProcessing(fileId, true);
    return { fileId, processingStatus: 'PENDING' };
  }

  async enqueueImageProcessing(fileId: string, force = false): Promise<void> {
    if (!fileId || !this.imageQueue || !this.isImageOptimizationEnabled()) {
      return;
    }
    try {
      await this.imageQueue.enqueueSingle(fileId, force);
    } catch (error) {
      this.logger.warn(`Failed to enqueue image processing for ${fileId}: ${String(error)}`);
    }
  }

  buildVariantS3Key(params: {
    variantKind: string;
    fileId: string;
    assetVersion: number;
    ext: string;
  }): string {
    const suffix = params.ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    return `variant/${String(params.variantKind).toUpperCase()}/${params.fileId}/v${params.assetVersion}.${suffix}`;
  }

  async putObjectBuffer(params: {
    key: string;
    body: Buffer;
    contentType: string;
    isPublic?: boolean;
  }): Promise<{ key: string; url: string }> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ACL: params.isPublic ? 'public-read' : undefined,
    } as any);
    await this.s3.send(command);
    return {
      key: params.key,
      url: this.buildS3ObjectUrl(params.key),
    };
  }

  async getObjectBufferByKey(key: string): Promise<Buffer> {
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }),
    );

    const body = result.Body as any;
    if (!body) {
      throw new BadRequestException('File object body is empty');
    }

    if (typeof body.transformToByteArray === 'function') {
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private shouldOptimizeFile(fileType: FileType, mimeType: string): boolean {
    if (!this.isImageOptimizationEnabled()) return false;
    if (
      fileType === FileType.POST_VIDEO ||
      fileType === FileType.REVIEW_VIDEO ||
      fileType === FileType.DOCUMENT ||
      fileType === FileType.MESSAGE_DOCUMENT
    ) {
      return false;
    }
    return String(mimeType || '').toLowerCase().startsWith('image/');
  }

  private isImageOptimizationEnabled(): boolean {
    const raw =
      this.configService.get<string>('IMAGE_OPTIMIZATION_ENABLED') ??
      this.configService.get<string>('IMAGE_VARIANTS_ENABLED') ??
      'false';
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
  }

  /** Map FileType enum → SystemConfig key */
  private static readonly FILE_TYPE_CONFIG_KEYS: Record<string, string> = {
    [FileType.PROFILE_IMAGE]: 'upload.maxSize.profileImage',
    [FileType.BANNER_IMAGE]: 'upload.maxSize.bannerImage',
    [FileType.POST_IMAGE]: 'upload.maxSize.postImage',
    [FileType.POST_VIDEO]: 'upload.maxSize.postVideo',
    [FileType.REVIEW_IMAGE]: 'upload.maxSize.reviewImage',
    [FileType.REVIEW_VIDEO]: 'upload.maxSize.reviewVideo',
    [FileType.DOCUMENT]: 'upload.maxSize.document',
    [FileType.BRAND_VERIFICATION]: 'upload.maxSize.brandVerification',
    [FileType.MESSAGE_IMAGE]: 'upload.maxSize.messageImage',
    [FileType.MESSAGE_DOCUMENT]: 'upload.maxSize.messageDocument',
  };

  private async validateFile(file: Express.Multer.File, fileType: FileType): Promise<void> {
    const configKey = UploadService.FILE_TYPE_CONFIG_KEYS[fileType];
    const maxSize = configKey
      ? await this.systemConfigService.getMaxFileSize(configKey)
      : 2 * 1024 * 1024; // 2MB fallback

    const allowedMimeTypes = {
      [FileType.PROFILE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
      [FileType.BANNER_IMAGE]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ],
      [FileType.POST_IMAGE]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ],
      [FileType.POST_VIDEO]: ['video/mp4', 'video/webm', 'video/quicktime'],
      [FileType.REVIEW_IMAGE]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ],
      [FileType.REVIEW_VIDEO]: ['video/mp4', 'video/webm', 'video/quicktime'],
      [FileType.DOCUMENT]: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      [FileType.BRAND_VERIFICATION]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
      ],
      [FileType.MESSAGE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
      [FileType.MESSAGE_DOCUMENT]: ['application/pdf'],
    };

    if (file.size > maxSize) {
      const limitMB = (maxSize / (1024 * 1024)).toFixed(1);
      throw new BadRequestException(`File size exceeds the ${limitMB}MB limit for ${fileType}`);
    }

    if (!allowedMimeTypes[fileType].includes(file.mimetype)) {
      throw new BadRequestException(`File type not allowed for ${fileType}`);
    }
  }

  private generateS3Key(
    fileType: FileType,
    userId: string,
    fileId: string,
    originalName: string,
  ): string {
    const extension = originalName.split('.').pop()?.toLowerCase() || '';
    const timestamp = Date.now();
    return `${fileType}/${userId}/${timestamp}-${fileId}.${extension}`;
  }
}
