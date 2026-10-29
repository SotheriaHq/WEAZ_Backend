import { loadActiveDisplayVariants } from './variant-display.util';
import { assertCompleteRasterImage } from '../media-processing/image-content-security';
import {
  deleteOwnedFile,
  deleteOrphanedMessageFiles,
} from './file-deletion-query';
import {
  resolveStorageProviderSettings,
  storageObjectUrl,
  signPublicGatewayUrl,
  type StorageProviderSettings,
} from './storage-provider.config';
import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  Optional,
  ServiceUnavailableException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FileUpload, PresignedUpload, Prisma } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { GetFilesDto } from './dto/get-files.dto';
import { PaginatedResult } from './dto/pagination.dto';
import { ConfigService } from '@nestjs/config';
import { FileType } from './upload.enums';
import { createHash } from 'crypto';
import { createRequire } from 'node:module';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import {
  assertAllowedUploadExtension,
  assertAllowedUploadMimeType,
  assertAllowedUploadType,
  DIRECT_UPLOAD_HARD_LIMIT_BYTES,
  formatUploadLimitMB,
  getUploadFileExtension,
  inferUploadContentType,
  normalizeUploadContentType,
} from './upload-policy';
import { MonitoringService } from 'src/monitoring/monitoring.service';
import { Readable } from 'stream';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

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

/**
 * Server-controlled validation overrides for an endpoint whose media policy is
 * more specific than the storage FileType. These are intentionally accepted
 * only from internal services, never from an HTTP request.
 */
export type UploadValidationOptions = {
  maxSizeConfigKey?: string;
  hardMaxSizeBytes?: number;
  /** Server-read, operation-local metadata; ownership and lease checks still apply. */
  presignSnapshot?: PresignedUpload;
};

type S3ObjectMetadata = {
  exists: boolean;
  contentLength: number;
  contentType: string | null;
  etag?: string;
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3: S3Client;
  private readonly bucketName: string;
  private readonly storageSettings: StorageProviderSettings;

  /**
   * TTL for signed URLs that back PUBLIC display media (feeds, collections,
   * profiles). Must outlive every client-side cache of API responses (the web
   * app persists queries to localStorage for up to 30 minutes and tabs stay
   * open far longer) or images 403 mid-session. 7 days is the SigV4 maximum.
   * Private, ownership-checked URLs (documents, verification) keep short TTLs.
   */
  private static readonly PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS =
    7 * 24 * 60 * 60;

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
      message: typeof anyErr?.message === 'string' ? anyErr.message : undefined,
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
    private readonly monitoring?: MonitoringService,
    @Optional()
    private readonly imageQueue?: ImageProcessingQueueService,
    @Optional()
    private readonly brandPermissions?: BrandPermissionService,
  ) {
    this.storageSettings = resolveStorageProviderSettings(this.configService);
    this.bucketName = this.storageSettings.bucket;
    const s3Config: any = {
      region: this.storageSettings.region,
      endpoint: this.storageSettings.endpoint,
      forcePathStyle: this.storageSettings.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: this.storageSettings.credentials,
      /*
        Two defaults are wrong for this workload, and both were measured rather
        than assumed.

        1. NO SOCKET TIMEOUT. A stalled R2 call blocks forever. That matters far
           more than it looks: the image-processing worker runs jobs one at a
           time, so a single wedged request stops image processing for every
           user until the process is restarted. `socketTimeout` is an INACTIVITY
           timeout, not a total one (verified in @smithy/node-http-handler:
           `setSocketTimeout` calls `socket.setTimeout`), so a slow-but-moving
           50MB video upload is unaffected — only a dead connection is cut.
           Deliberately NOT `requestTimeout`, which IS total wall-clock and
           would cap legitimate large uploads.

        2. CONNECTION REUSE LEFT TO THE SDK. Whether keep-alive is on by default
           has changed between SDK versions, and on SIT the bucket
           (af-south-1) is a different continent from the box (us-east-1) —
           measured at 228ms just to connect. A fresh TLS handshake per request
           costs several of those round trips, on the hot path of every upload
           and every variant written back.
      */
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        socketTimeout: 30_000,
        httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 64 }),
      }),
    };

    this.s3 = new S3Client(s3Config);
  }

  private buildS3ObjectUrl(key: string): string {
    return storageObjectUrl(this.storageSettings, key);
  }

  private getFileExtension(fileName: string): string {
    return getUploadFileExtension(fileName);
  }

  private assertAllowedExtension(
    originalName: string,
    fileType: FileType,
  ): void {
    assertAllowedUploadExtension(originalName, fileType);
  }

  private normalizeContentType(contentType?: string | null): string | null {
    return normalizeUploadContentType(contentType);
  }

  private inferContentType(fileName: string): string | null {
    return inferUploadContentType(fileName);
  }

  private assertAllowedMimeType(
    mimeType: string | null,
    fileType: FileType,
  ): asserts mimeType is string {
    assertAllowedUploadMimeType(mimeType, fileType);
  }

  private async getMaxFileSize(
    fileType: FileType,
    options: UploadValidationOptions = {},
  ): Promise<number> {
    const configKey =
      options.maxSizeConfigKey ?? UploadService.FILE_TYPE_CONFIG_KEYS[fileType];
    const configuredMaxSize = configKey
      ? this.systemConfigService.getMaxFileSize(configKey)
      : Promise.resolve(2 * 1024 * 1024);
    const maxSize = await configuredMaxSize;
    const hardMaxSize = DIRECT_UPLOAD_HARD_LIMIT_BYTES[fileType];
    const requestedHardMax = options.hardMaxSizeBytes ?? hardMaxSize;
    if (
      !hardMaxSize ||
      !Number.isFinite(maxSize) ||
      maxSize <= 0 ||
      !Number.isFinite(requestedHardMax) ||
      requestedHardMax <= 0
    ) {
      throw new ServiceUnavailableException(
        'Upload size policy is unavailable',
      );
    }
    return Math.min(maxSize, hardMaxSize, requestedHardMax);
  }

  private getStablePublicDisplayUrl(file: {
    s3Url?: string | null;
    s3Key?: string | null;
  }): string | null {
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    return key && this.storageSettings.publicGateway
      ? signPublicGatewayUrl(this.storageSettings.publicGateway, key)
      : null;
  }

  getPublicDisplayUrl(_file: {
    s3Url?: string | null;
    s3Key?: string | null;
    isPublic?: boolean | null;
  }): string | null {
    // A supplied URL/public flag cannot replace current parent authorization.
    void _file;
    return null;
  }

  async getTemporarySignedDisplayUrl(
    file: { id?: string | null; s3Key?: string | null },
    expiresIn = UploadService.PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS,
  ): Promise<string | null> {
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    if (!key) return null;

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

  /**
   * Displayable on market/admin when the object exists in S3 even if the async
   * image pipeline never flipped processingStatus to READY (common for older
   * product/design uploads that still have a valid s3Key).
   */
  private isDisplayableStoredFile(file: any): boolean {
    if (!file || file.originalDeletedAt) return false;
    const key = typeof file.s3Key === 'string' ? file.s3Key.trim() : '';
    if (!key) return false;
    const status = String(file.processingStatus ?? 'READY').toUpperCase();
    return status !== 'FAILED';
  }

  /**
   * Shared Prisma include for public URL authorization checks.
   *
   * Every key here MUST be a real relation on `FileUpload` (schema.prisma
   * ~L197). Prisma validates includes at call time, not compile time, so a name
   * that does not exist throws `PrismaClientValidationError` and turns every
   * consumer into a 500 — and because `findMany`/`findUnique` are mocked in the
   * spec, the unit tests cannot catch it. This exact mistake took the owner
   * catalog, the drafts tab and all media display URLs down for two days
   * (2026-07-28 17:52 → 2026-07-30) via a stale `designMedias` key.
   *
   * There is no `designMedias` key, and that is a STORAGE fact, not a statement
   * that designs and store collections are the same domain — they are not, and
   * the authorization rules below keep them apart deliberately.
   *
   * The 2026-07-24 decoupling pivot separated designs from store collections at
   * the API/service boundary but DEFERRED the physical table move, so a design is
   * still persisted as `Collection(domain = DESIGN)` with `designId ===
   * collectionId`, and its media are `CollectionMedia` rows. The standalone
   * `DesignMedia` table is inert and `FileUpload` has no relation to it, so any
   * design-scoped read has to come through `collectionMedias` filtered on
   * `domain` — hence `domain` is selected here.
   *
   * When the physical DesignMedia table does land, the only change needed is to
   * point `isPublicDesignFile` at the new relation; the design/store split in the
   * predicates already reflects the intended end state.
   */
  private publicFileAccessInclude() {
    return {
      collectionMedias: {
        include: {
          collection: {
            select: {
              id: true,
              domain: true,
              status: true,
              visibility: true,
              deletedAt: true,
            },
          },
        },
      },
      productMedias: {
        include: {
          product: {
            select: {
              id: true,
              isActive: true,
              publicationStatus: true,
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
    } as const;
  }

  /**
   * Shared publish gate for a `Collection`-backed row of either domain. Split out
   * so the design and store predicates below stay one line each and cannot drift
   * apart by accident — if the two domains ever need different rules, override in
   * the caller rather than adding a flag here.
   */
  private isAnonymouslySignableCollectionRow(collection: any): boolean {
    // Only published + public rows are anonymously signable. In-review, draft,
    // rejected and private previews must go through the authenticated
    // signed-url paths; that is what stops unapproved content from leaking when
    // a fileId or S3 key escapes.
    return Boolean(
      collection &&
        collection.status === 'PUBLISHED' &&
        collection.visibility === 'PUBLIC' &&
        !collection.deletedAt,
    );
  }

  private collectionMediasForDomain(file: any, domain: 'DESIGN' | 'STORE') {
    const medias = Array.isArray(file?.collectionMedias)
      ? file.collectionMedias
      : [];
    // `domain` is the design/store boundary. A CollectionMedia row with no
    // domain loaded is NOT assumed to be either — failing closed here keeps a
    // partial select from silently widening public access.
    return medias.filter((media: any) => media?.collection?.domain === domain);
  }

  /**
   * Design media. Reads `collectionMedias` filtered to `domain = DESIGN` only
   * because the physical DesignMedia table move is still deferred — designs are a
   * separate domain with their own endpoints (`/designs/*`), and this predicate is
   * the design rule, not the collection rule. Repoint the read here when the
   * dedicated relation exists.
   */
  private isPublicDesignFile(file: any): boolean {
    return this.collectionMediasForDomain(file, 'DESIGN').some((media: any) =>
      this.isAnonymouslySignableCollectionRow(media?.collection),
    );
  }

  /**
   * Store-collection media — a curated group of products under `/collections/*`,
   * a different thing from a design. Kept separate from `isPublicDesignFile` so
   * the two can diverge without untangling them again.
   */
  private isPublicStoreCollectionFile(file: any): boolean {
    return this.collectionMediasForDomain(file, 'STORE').some((media: any) =>
      this.isAnonymouslySignableCollectionRow(media?.collection),
    );
  }

  private isPublicProductFile(file: any): boolean {
    const medias = Array.isArray(file?.productMedias) ? file.productMedias : [];
    return medias.some((media: any) => {
      const product = media?.product;
      if (!product || product.deletedAt) return false;
      // Active listed products (or explicitly published) may be shown on Market.
      if (product.isActive === false) return false;
      const status = String(product.publicationStatus ?? '').toUpperCase();
      // Only fully published catalog products may be anonymously signed.
      if (status && status !== 'PUBLISHED') {
        return false;
      }
      return true;
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
    if (!this.isDisplayableStoredFile(file)) return false;
    if (
      [
        'DOCUMENT',
        'BRAND_VERIFICATION',
        'MESSAGE_IMAGE',
        'MESSAGE_DOCUMENT',
      ].includes(file.fileType)
    )
      return false;
    // Intentionally no bare POST_IMAGE/POST_VIDEO prefix bypass: that allowed
    // draft/in-review media to be signed anonymously when a key/fileId leaked.
    return Boolean(
      file.isPublic ||
        this.isPublicDesignFile(file) ||
        this.isPublicStoreCollectionFile(file) ||
        this.isPublicProductFile(file) ||
        this.isPublicIdentityFile(file),
    );
  }

  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    fileType: FileType,
    validationOptions: UploadValidationOptions = {},
  ): Promise<FileUploadResult> {
    const record = await this.storeServerUpload(
      file,
      userId,
      fileType,
      validationOptions,
    );
    return {
      id: record.id,
      url: record.s3Url,
      key: record.s3Key,
      fileName: record.fileName,
      originalName: record.originalName,
      size: record.size,
      mimeType: record.mimeType,
      fileType: record.fileType as FileType,
      processingStatus: record.processingStatus,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private async storeServerUpload(
    file: Express.Multer.File,
    userId: string,
    fileType: FileType,
    validationOptions: UploadValidationOptions = {},
  ): Promise<FileUpload> {
    await this.validateFile(file, fileType, validationOptions);
    if (
      !Buffer.isBuffer(file.buffer) ||
      !file.buffer.length ||
      file.buffer.length !== file.size
    ) {
      throw new BadRequestException('Uploaded file is empty or incomplete');
    }
    const mimeType = this.normalizeContentType(file.mimetype)!;
    const intent = await this.createUploadIntent(
      userId,
      file.originalname,
      fileType,
      mimeType,
    );
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: intent.s3Key,
          Body: file.buffer,
          ContentType: mimeType,
          ContentDisposition: 'inline',
          CacheControl: 'private, max-age=0, no-store',
        }),
      );
      return await this.createFileRecordFromPresign(
        intent.id,
        userId,
        intent.s3Key,
        mimeType,
        file.size,
        undefined,
        validationOptions,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const details = this.summarizeAwsError(error);
      this.logger.error('Media upload could not complete', {
        name: details.name,
        httpStatusCode: details.httpStatusCode,
      });
      throw new ServiceUnavailableException(
        'Upload could not complete. Please retry.',
      );
    }
  }

  private async createUploadIntent(
    userId: string,
    originalName: string,
    fileType: FileType,
    contentType: string,
    options?: {
      collectionId?: string;
      orderIndex?: number;
      viewSlot?: string | null;
    },
  ) {
    const id = uuidv4();
    const generatedKey = this.generateS3Key(fileType, userId, id, originalName);
    const s3Key = generatedKey.replace(
      `${fileType}/${userId}/`,
      `${fileType}/${userId}/pending/`,
    );
    const data = {
      id,
      userId,
      originalName,
      contentType,
      fileType,
      s3Key,
      collectionId: options?.collectionId,
      orderIndex:
        typeof options?.orderIndex === 'number' ? options.orderIndex : null,
      viewSlot: options?.viewSlot ?? null,
      expiresAt: new Date(Date.now() + 600_000),
    };
    // The intent is durable before any external storage write; expired staging is recoverable.
    await this.prisma.presignedUpload.create({ data: data as any });
    return data;
  }

  // Generate presigned POST data for client direct-to-S3 uploads
  async createPresignedUpload(
    userId: string,
    originalName: string,
    fileType: FileType,
    contentType?: string,
    options?: {
      collectionId?: string;
      orderIndex?: number;
      viewSlot?: string | null;
    },
  ) {
    // Persist staging intent before issuing an R2 PUT capability.
    this.assertAllowedExtension(originalName, fileType);
    const trustedContentType =
      this.normalizeContentType(contentType) ??
      this.inferContentType(originalName);
    this.assertAllowedMimeType(trustedContentType, fileType);
    assertAllowedUploadType(originalName, trustedContentType, fileType);
    await this.getMaxFileSize(fileType);

    const intent = await this.createUploadIntent(
      userId,
      originalName,
      fileType,
      trustedContentType,
      options,
    );
    const fileId = intent.id;
    const key = intent.s3Key;
    const uploadHeaders = {
      'Content-Type': trustedContentType,
      'Cache-Control': 'private, max-age=0, no-store',
    };
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: trustedContentType,
        CacheControl: 'private, max-age=0, no-store',
      }),
      { expiresIn: 600, signableHeaders: new Set(['content-type']) },
    );
    return {
      url,
      key,
      fileId,
      fields: {},
      method: 'PUT',
      uploadHeaders,
      expiresIn: 600,
    };
  }

  async updateUserProfileImage(
    userId: string,
    file: Pick<FileUploadResult, 'id' | 'url'>,
  ): Promise<void> {
    const profilePhotoUpdatedAt = new Date();
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
          profilePhotoUpdatedAt,
        },
        update: {
          profileImageId: file.id,
          profileImage: file.url,
          profilePhotoUpdatedAt,
        },
      });
      // Strict sync: store logo mirrors brand profile image.
      await tx.brand.updateMany({
        where: { ownerId: userId },
        data: { logo: file.url },
      });
    });
  }

  async clearUserProfileImage(userId: string): Promise<void> {
    const profilePhotoUpdatedAt = new Date();
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
          profilePhotoUpdatedAt,
        },
        update: {
          profileImageId: null,
          profileImage: null,
          profilePhotoUpdatedAt,
        },
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

  async getSignedUrl(
    fileId: string,
    userId: string,
    role?: string | null,
  ): Promise<string> {
    // Do NOT require ownership in the WHERE clause — admins and public market
    // viewers need to resolve other brands' product/design media. Authorize after load.
    const file = await this.prisma.fileUpload.findUnique({
      where: { id: fileId },
      include: this.publicFileAccessInclude() as any,
    });

    if (!file) {
      throw new BadRequestException('File not found');
    }
    if (!this.isDisplayableStoredFile(file)) {
      this.logger.warn(
        `[media] signed-url denied for unavailable file fileId=${fileId}`,
      );
      throw new BadRequestException('File not available');
    }

    const isOwner = file.userId === userId;
    const normalizedRole = String(role ?? '');
    const isAdmin =
      normalizedRole === 'Admin' || normalizedRole === 'SuperAdmin';
    if (
      !isOwner &&
      !isAdmin &&
      !this.canReturnPublicFileUrl(file) &&
      (!userId ||
        !(await this.loadSharedViewerFileIds([file.id], userId)).has(file.id))
    ) {
      throw new BadRequestException('File not found');
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
      include: this.publicFileAccessInclude() as any,
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

    return await getSignedUrl(this.s3, command, {
      expiresIn: UploadService.PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS,
    });
  }

  /**
   * Get signed URL by stored object key.
   * Used when the frontend has a stored R2 URL / storage key and needs a
   * signed version (market rails, content-review previews, catalog cards).
   */
  /** Resolve only stored aliases or configured media origins. Never fetch caller URLs. */
  async resolveMediaSourceKey(source: string): Promise<string | null> {
    return (await this.resolveMediaSourceKeys([source])).get(source) ?? null;
  }

  private async resolveMediaSourceKeys(
    sources: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const aliases = new Map<string, string[]>();
    const bases = [this.storageSettings?.publicGateway?.baseUrl]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value));
    for (const source of sources) {
      if (typeof source !== 'string' || source.length > 8192) continue;
      let url: URL;
      try {
        url = new URL(source);
      } catch {
        continue;
      }
      if (
        url.username ||
        url.password ||
        !['https:', 'http:'].includes(url.protocol)
      )
        continue;
      for (const base of bases) {
        const prefix = `${base.pathname.replace(/\/+$/, '')}/`;
        if (url.origin !== base.origin || !url.pathname.startsWith(prefix))
          continue;
        try {
          const key = decodeURIComponent(url.pathname.slice(prefix.length));
          if (
            key &&
            !key.includes('..') &&
            !key.includes('\\') &&
            !key.startsWith('/')
          )
            result.set(source, key);
        } catch {
          /* Invalid escaping cannot identify a media object. */
        }
      }
      if (result.has(source)) continue;
      const identity = `${url.origin}${url.pathname}`;
      aliases.set(identity, [...(aliases.get(identity) ?? []), source]);
    }
    if (aliases.size) {
      const identities = [...aliases.keys()];
      const [files, variants] = await Promise.all([
        this.prisma.fileUpload.findMany({
          where: { s3Url: { in: identities } },
          select: { s3Url: true, s3Key: true },
        }),
        this.prisma.fileVariant.findMany({
          where: { s3Url: { in: identities } },
          select: { s3Url: true, s3Key: true },
        }),
      ]);
      for (const row of [...files, ...variants])
        for (const source of aliases.get(row.s3Url) ?? [])
          result.set(source, row.s3Key);
    }
    return result;
  }

  async getBatchSignedUrlsBySource(
    sources: string[],
    user?: { id?: string; role?: string },
  ): Promise<Array<{ source: string; url: string | null }>> {
    if (sources.length > 50)
      throw new BadRequestException('At most 50 media sources are allowed');
    const keys = await this.resolveMediaSourceKeys(sources);
    const uniqueKeys = [...new Set(keys.values())];
    if (!uniqueKeys.length)
      return sources.map((source) => ({ source, url: null }));
    const variants = await this.prisma.fileVariant.findMany({
      where: { s3Key: { in: uniqueKeys } },
    });
    const files = await this.prisma.fileUpload.findMany({
      where: {
        OR: [
          { s3Key: { in: uniqueKeys } },
          { id: { in: [...new Set(variants.map((row) => row.fileUploadId))] } },
        ],
      },
      include: this.publicFileAccessInclude(),
    });
    const filesById = new Map(files.map((file) => [file.id, file]));
    const filesByKey = new Map(files.map((file) => [file.s3Key, file]));
    const variantsByKey = new Map(
      variants.map((variant) => [variant.s3Key, variant]),
    );
    const sharedIds =
      user?.id && !['Admin', 'SuperAdmin'].includes(user.role ?? '')
        ? await this.loadSharedViewerFileIds(
            files
              .filter(
                (file) =>
                  file.userId !== user.id && !this.canReturnPublicFileUrl(file),
              )
              .map((file) => file.id),
            user.id,
          )
        : new Set<string>();
    const urls = new Map<string, string>();
    await Promise.all(
      uniqueKeys.map(async (key) => {
        const variant = variantsByKey.get(key);
        const file =
          filesByKey.get(key) ??
          (variant ? filesById.get(variant.fileUploadId) : undefined);
        if (!file || !this.isDisplayableStoredFile(file)) return;
        if (variant && variant.assetVersion !== file.assetVersion) return;
        const isPublic = this.canReturnPublicFileUrl(file);
        const isOwnerOrAdmin =
          user?.id &&
          (file.userId === user.id ||
            ['Admin', 'SuperAdmin'].includes(user.role ?? ''));
        if (!isPublic && !isOwnerOrAdmin && !sharedIds.has(file.id)) return;
        const gatewayUrl = isPublic
          ? this.getStablePublicDisplayUrl({ s3Key: key })
          : null;
        urls.set(
          key,
          gatewayUrl ??
            (await getSignedUrl(
              this.s3,
              new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
              {
                expiresIn: isPublic
                  ? UploadService.PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS
                  : 3600,
              },
            )),
        );
      }),
    );
    return sources.map((source) => ({
      source,
      url: urls.get(keys.get(source) ?? '') ?? null,
    }));
  }

  private async loadSharedViewerFileIds(
    fileIds: string[],
    viewerId: string,
  ): Promise<Set<string>> {
    const ids = [...new Set(fileIds)].filter((id) =>
      /^[0-9a-f-]{36}$/i.test(id),
    );
    if (!ids.length) return new Set();
    const privateCollectionsEnabled =
      String(
        this.configService.get('FEATURE_PRIVATE_COLLECTIONS') ?? 'true',
      ) !== 'false';
    const brandRead =
      this.brandPermissions?.buildPermissionPredicate(
        viewerId,
        BRAND_PERMISSIONS.MESSAGES_READ,
        Prisma.sql`resolved_brand."_id"`,
        Prisma.sql`resolved_brand."ownerId"`,
      ) ?? Prisma.sql`FALSE`;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT file."_id" AS id FROM "FileUpload" file
      WHERE file."_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND (
          (${privateCollectionsEnabled} AND EXISTS (
            SELECT 1 FROM "CollectionMedia" media
            JOIN "Collection" target ON target."_id" = media."collectionId"
            JOIN "CollectionAccess" approval ON approval."viewerId" = ${viewerId}::uuid AND approval.state = 'APPROVED'
            JOIN "Collection" granted ON granted."_id" = approval."collectionId" AND granted."ownerId" = target."ownerId"
            WHERE media."fileUploadId" = file."_id"
              AND target.status = 'PUBLISHED' AND target.visibility = 'PRIVATE' AND target."deletedAt" IS NULL
              AND granted.status = 'PUBLISHED' AND granted.visibility = 'PRIVATE' AND granted."deletedAt" IS NULL
          )) OR EXISTS (
            SELECT 1 FROM "MessageAttachment" attachment
            JOIN "Message" message ON message.id = attachment."messageId"
            JOIN "MessageThread" thread ON thread.id = message."threadId"
            LEFT JOIN "Order" standard_order ON standard_order."_id" = thread."orderId"
            LEFT JOIN "CustomOrder" custom_order ON custom_order.id = thread."customOrderId"
            LEFT JOIN "Brand" resolved_brand ON resolved_brand."_id" = COALESCE(thread."brandId", standard_order."brandId", custom_order."brandId")
              OR resolved_brand."ownerId" = COALESCE(thread."brandId", standard_order."brandId", custom_order."brandId")
            WHERE attachment."fileUploadId" = file."_id" AND message."visibilityState" = 'VISIBLE'
              AND (EXISTS (SELECT 1 FROM "MessageThreadParticipant" participant
                WHERE participant."threadId" = message."threadId" AND participant."userId" = ${viewerId}::uuid)
                OR ${brandRead})
          )
        )
    `);
    return new Set(rows.map((row) => row.id));
  }

  async getPublicSignedUrlByKey(s3Key: string): Promise<string | null> {
    const normalizedKey = typeof s3Key === 'string' ? s3Key.trim() : '';
    if (!normalizedKey || normalizedKey.includes('..')) {
      throw new BadRequestException('Invalid S3 key');
    }

    const accessInclude = this.publicFileAccessInclude();

    const directFile = await this.prisma.fileUpload.findUnique({
      where: { s3Key: normalizedKey },
      include: accessInclude as any,
    });

    const variant = directFile
      ? null
      : await (this.prisma as any).fileVariant.findFirst({
          where: { s3Key: normalizedKey },
          include: {
            file: {
              include: accessInclude,
            },
          },
        });

    const sourceFile = directFile ?? variant?.file ?? null;
    if (!sourceFile || !this.canReturnPublicFileUrl(sourceFile)) {
      this.logger.warn(
        `[media] public-url-by-key denied keyPrefix=${normalizedKey.split('/')[0] ?? 'unknown'}`,
      );
      return null;
    }

    // A URL for a superseded variant must not bypass the active asset version.
    if (
      variant &&
      Number(variant.assetVersion) !== Number(sourceFile.assetVersion ?? 1)
    ) {
      return null;
    }

    const stablePublicUrl = this.getStablePublicDisplayUrl({
      s3Key: normalizedKey,
      s3Url: directFile?.s3Url,
    });
    if (stablePublicUrl) {
      return stablePublicUrl;
    }

    // Authorize against the parent, but retain the requested variant's size.
    const signKey = variant?.s3Key || directFile?.s3Key || normalizedKey;

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: signKey,
    });

    return await getSignedUrl(this.s3, command, {
      expiresIn: UploadService.PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS,
    });
  }

  /**
   * Sign a brand-verification evidence file for an admin reviewer.
   *
   * Verification evidence (NIN slips, ID scans, CAC certificates, the signed
   * letter) is deliberately private: `isPublic` is false and the file has no
   * profile/design/product relation, so `canReturnPublicFileUrl` denies it and
   * `getPublicSignedUrlByKey` returns null. The admin review page was signing
   * through that public path, which meant EVERY document came back with
   * `signedUrl: null` — the reviewer saw "No reviewer preview is available"
   * for all evidence including the signed verification letter, and had no way
   * to approve or reject on anything but the typed form fields.
   *
   * Callers must already be authorized reviewers (the only route in is
   * `GET /admin/brands/:id/verification`, behind `BRANDS_VERIFY`). The
   * `fileType` check below is the hard stop that keeps this from becoming a
   * general private-media signer: it can only ever sign BRAND_VERIFICATION
   * objects, never drafts, DMs or anyone's private uploads.
   */
  async getVerificationReviewSignedUrlByKey(
    s3Key: string,
  ): Promise<string | null> {
    const normalizedKey = typeof s3Key === 'string' ? s3Key.trim() : '';
    if (!normalizedKey || normalizedKey.includes('..')) return null;

    const file = await this.prisma.fileUpload.findUnique({
      where: { s3Key: normalizedKey },
      select: {
        s3Key: true,
        fileType: true,
        processingStatus: true,
        originalDeletedAt: true,
      },
    });
    return this.signVerificationReviewFile(file);
  }

  async getVerificationReviewSignedUrlsByKey(
    keys: string[],
  ): Promise<Map<string, string>> {
    const valid = [
      ...new Set(
        keys
          .map((key) => key.trim())
          .filter((key) => key && !key.includes('..')),
      ),
    ];
    const urls = new Map<string, string>();
    for (let offset = 0; offset < valid.length; offset += 50) {
      const files = await this.prisma.fileUpload.findMany({
        where: { s3Key: { in: valid.slice(offset, offset + 50) } },
        select: {
          s3Key: true,
          fileType: true,
          processingStatus: true,
          originalDeletedAt: true,
        },
      });
      await Promise.all(
        files.map(async (file) => {
          const signed = await this.signVerificationReviewFile(file);
          if (signed) urls.set(file.s3Key, signed);
        }),
      );
    }
    return urls;
  }

  private async signVerificationReviewFile(
    file: Pick<
      FileUpload,
      's3Key' | 'fileType' | 'processingStatus' | 'originalDeletedAt'
    > | null,
  ): Promise<string | null> {
    if (!file || !this.isDisplayableStoredFile(file)) return null;
    if (String(file.fileType) !== String(FileType.BRAND_VERIFICATION)) {
      this.logger.warn(
        `[media] verification-review signing denied for non-verification file keyPrefix=${file.s3Key.split('/')[0] ?? 'unknown'}`,
      );
      return null;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: file.s3Key,
    });
    return await getSignedUrl(this.s3, command, { expiresIn: 900 });
  }

  /**
   * Authenticated key-based signing for owners/admins. Used when public
   * signing is denied (drafts, private, ownership-gated previews).
   */
  async getSignedUrlByKeyForUser(
    s3Key: string,
    user: { id?: string; role?: string } | null | undefined,
  ): Promise<string | null> {
    const normalizedKey = typeof s3Key === 'string' ? s3Key.trim() : '';
    if (!normalizedKey || normalizedKey.includes('..')) {
      throw new BadRequestException('Invalid S3 key');
    }
    if (!user?.id) return null;

    const accessInclude = this.publicFileAccessInclude();
    const directFile = await this.prisma.fileUpload.findUnique({
      where: { s3Key: normalizedKey },
      include: accessInclude as any,
    });
    const variant = directFile
      ? null
      : await this.prisma.fileVariant.findFirst({
          where: { s3Key: normalizedKey },
          include: { file: { include: accessInclude } },
        });
    const file = directFile ?? variant?.file;
    if (!file || !this.isDisplayableStoredFile(file)) {
      return null;
    }
    if (variant && variant.assetVersion !== file.assetVersion) return null;

    const role = String(user.role ?? '');
    const isAdmin = role === 'Admin' || role === 'SuperAdmin';
    const isOwner = file.userId === user.id;
    if (
      !isAdmin &&
      !isOwner &&
      !this.canReturnPublicFileUrl(file) &&
      !(await this.loadSharedViewerFileIds([file.id], user.id)).has(file.id)
    ) {
      return null;
    }

    const signKey =
      variant?.s3Key ||
      (typeof file.s3Key === 'string' && file.s3Key.trim()) ||
      normalizedKey;
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: signKey,
    });
    return await getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }

  /**
   * Batch generate display URLs for multiple files (optimized for feeds).
   *
   * `trustCallerAuthorization` picks between the two very different situations
   * this batch serves, and getting it wrong is either a leak or a broken image:
   *
   *  - `false` (default) — the file IDs came from somewhere unvouched (a client
   *    payload, a raw key, a cross-brand feed join). Every file must pass the
   *    anonymous gate in `canReturnPublicFileUrl`: published + public rows only.
   *
   *  - `true` — the SERVER picked these IDs out of rows it had already
   *    authorized for this requester (owner catalog, drafts, approved-private
   *    collections). Re-deriving the anonymous rule here is simply wrong: a
   *    draft is by definition neither PUBLISHED nor PUBLIC, so the gate rejected
   *    every one of the owner's own draft covers and the batch returned an empty
   *    map. That is why draft cards had a broken image 100% of the time — and
   *    the same silent drop hit the owner's Private and In-review tabs, plus
   *    private collections shared with an approved viewer.
   *
   * Non-public files are always given a SIGNED url even where a public CDN base
   * is configured, so trusting the caller's row-level authorization never turns
   * unpublished media into an anonymously fetchable object URL.
   */
  private async resolveBatchDisplayUrls(
    fileIds: string[],
    trustCallerAuthorization: boolean,
  ): Promise<Map<string, string>> {
    if (!fileIds || fileIds.length === 0) {
      return new Map<string, string>();
    }
    const accessInclude = this.publicFileAccessInclude();
    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: fileIds } },
      include: accessInclude as any,
    });

    const urlMap = new Map<string, string>();

    const chunkSize = 25;
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (file) => {
          const isAnonymouslyPublic = this.canReturnPublicFileUrl(file);
          if (!isAnonymouslyPublic) {
            // The caller's vouch covers authorization, never availability: a
            // quarantined, key-less or FAILED upload stays unrenderable.
            if (
              !trustCallerAuthorization ||
              !this.isDisplayableStoredFile(file)
            ) {
              return null;
            }
          }

          if (isAnonymouslyPublic) {
            const stablePublicUrl = this.getStablePublicDisplayUrl(file);
            if (stablePublicUrl) {
              return [file.id, stablePublicUrl] as const;
            }
          }

          const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: file.s3Key,
          });
          const signedUrl = await getSignedUrl(this.s3, command, {
            expiresIn: UploadService.PUBLIC_DISPLAY_SIGNED_URL_TTL_SECONDS,
          });
          return [file.id, signedUrl] as const;
        }),
      );
      for (const entry of results) {
        if (!entry) continue;
        const [id, url] = entry;
        urlMap.set(id, url);
      }
    }

    return urlMap;
  }

  /**
   * Batch generate signed URLs for multiple files (optimized for feeds).
   * Anonymous rules apply — see `resolveBatchDisplayUrls`.
   */
  async getBatchPublicSignedUrls(
    fileIds: string[],
  ): Promise<Map<string, string>> {
    return this.resolveBatchDisplayUrls(fileIds, false);
  }

  /**
   * Batch display URLs for file IDs the SERVER selected from rows it has
   * already authorized for the current requester.
   *
   * ONLY call this with IDs read off rows returned by a query that applied the
   * requester's visibility rules (ownership, `status`, `accesses.some(...)`).
   * Never pass IDs that originated in the request body or a URL param — those
   * belong to `getBatchPublicSignedUrls`.
   */
  async getBatchAuthorizedDisplayUrls(
    fileIds: string[],
  ): Promise<Map<string, string>> {
    return this.resolveBatchDisplayUrls(fileIds, true);
  }

  /**
   * Batch-resolve a processed variant (e.g. AVATAR for brand logos on feed
   * cards) so public surfaces stop serving multi-hundred-KB originals. WEBP
   * outranks AVIF: these are single-URL payloads rendered as plain <img>, and
   * AVIF breaks on iOS Safari < 16.4. Returns URLs only for files that already
   * have the variant — callers keep the original display URL as fallback, so
   * access checks stay with the original-file batch.
   */
  async getBatchVariantDisplayUrls(
    fileIds: string[],
    variantKind: string,
  ): Promise<Map<string, string>> {
    if (!fileIds || fileIds.length === 0) {
      return new Map<string, string>();
    }

    const rows = await loadActiveDisplayVariants(
      this.prisma,
      fileIds,
      variantKind,
    );

    const formatRank = (format: unknown): number => {
      const value = String(format ?? '').toUpperCase();
      if (value === 'WEBP') return 0;
      if (value === 'AVIF') return 1;
      return 2;
    };

    const bestByFile = new Map<string, any>();
    for (const row of rows ?? []) {
      const id = typeof row?.fileUploadId === 'string' ? row.fileUploadId : '';
      if (!id) continue;
      const current = bestByFile.get(id);
      if (!current || formatRank(row.format) < formatRank(current.format)) {
        bestByFile.set(id, row);
      }
    }

    const urlMap = new Map<string, string>();
    for (const [id, row] of bestByFile) {
      const key = typeof row?.s3Key === 'string' ? row.s3Key.trim() : '';
      if (!key) continue;
      const url =
        this.getPublicDisplayUrl({
          s3Key: key,
          s3Url: row?.s3Url ?? null,
          isPublic: true,
        }) ??
        (await this.getTemporarySignedDisplayUrl({ id, s3Key: key }, 3600));
      if (url) {
        urlMap.set(id, url);
      }
    }

    return urlMap;
  }

  async deleteFile(fileId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(
      (tx) => deleteOwnedFile(tx, fileId, userId),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }

  async cleanupOrphanedMessageFiles(
    cutoff: Date,
    batchSize = 100,
  ): Promise<number> {
    return this.prisma.$transaction(
      (tx) => deleteOrphanedMessageFiles(tx, cutoff, batchSize),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /** Removing one content link must retain a file still used by another item. */
  async deleteFileIfUnused(fileId: string, userId: string): Promise<boolean> {
    const deleted = await this.prisma.$transaction(
      (tx) => deleteOwnedFile(tx, fileId, userId, false),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return deleted > 0;
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
      this.logger.error('S3 deleteObject failed', {
        keyHash: this.hashStorageKey(key),
        error: this.summarizeAwsError(err),
      });
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

  private async headObjectMetadata(key: string): Promise<S3ObjectMetadata> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const result = await this.s3.send(command);
      return {
        exists: true,
        contentLength:
          typeof result.ContentLength === 'number' ? result.ContentLength : 0,
        contentType: this.normalizeContentType(result.ContentType),
        etag: result.ETag,
      };
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
        this.logger.warn('S3 object was not found', {
          keyHash: this.hashStorageKey(key),
        });
        return { exists: false, contentLength: 0, contentType: null };
      }

      this.logger.error('S3 headObject failed', {
        keyHash: this.hashStorageKey(key),
        ...details,
      });
      this.emitUploadAlert('upload_storage_head_failed', 'error', {
        keyHash: this.hashStorageKey(key),
        ...details,
      });
      throw new ServiceUnavailableException(
        'Storage is temporarily unavailable. Please retry in a moment.',
      );
    }
  }

  // Verify S3 object exists by key
  async verifyObjectExists(key: string): Promise<boolean> {
    return (await this.headObjectMetadata(key)).exists;
  }

  // Create a FileUpload DB record after presigned upload
  async createFileRecordFromPresign(
    id: string,
    userId: string,
    key: string,
    mimeType: string,
    size: number,
    originalId?: string,
    validationOptions: UploadValidationOptions = {},
  ) {
    // Look up presign record to get originalName and fileType
    if (
      validationOptions.presignSnapshot &&
      validationOptions.presignSnapshot.id !== id
    ) {
      throw new BadRequestException(
        'Presign snapshot does not match the requested upload',
      );
    }
    const presign =
      validationOptions.presignSnapshot ??
      (await this.prisma.presignedUpload.findUnique({
        where: { id },
      }));
    if (!presign) {
      throw new BadRequestException('Presign record not found');
    }

    if (presign.userId !== userId) {
      this.emitUploadAlert('upload_finalize_owner_mismatch', 'warning', {
        presignId: id,
        actorId: userId,
        ownerId: presign.userId,
        fileType: presign.fileType,
      });
      throw new ForbiddenException('Presign record does not belong to user');
    }

    if (presign.s3Key !== key) {
      this.emitUploadAlert('upload_finalize_key_mismatch', 'warning', {
        presignId: id,
        actorId: userId,
        fileType: presign.fileType,
        expectedKeyHash: this.hashStorageKey(presign.s3Key),
        receivedKeyHash: this.hashStorageKey(key),
      });
      throw new BadRequestException('S3 key mismatch for presign record');
    }

    if (presign.status === 'USED') {
      const existing = await this.prisma.fileUpload.findUnique({
        where: { id },
      });
      if (existing) return existing;
      throw new BadRequestException('Presign already used');
    }

    // An expired upload capability does not invalidate an already committed file.
    const now = new Date();
    if (presign.expiresAt && presign.expiresAt < now) {
      throw new BadRequestException('Presign has expired');
    }

    if (presign.status === 'EXPIRED') {
      throw new BadRequestException('Presign has expired');
    }

    if (presign.status !== 'PENDING' && presign.status !== 'READY') {
      throw new BadRequestException('Presign is not ready for use');
    }

    const expectedPrefix = `${presign.fileType}/${userId}/`;
    if (!key.startsWith(expectedPrefix)) {
      this.emitUploadAlert('upload_finalize_prefix_mismatch', 'warning', {
        presignId: id,
        actorId: userId,
        fileType: presign.fileType,
        keyHash: this.hashStorageKey(key),
      });
      throw new BadRequestException(
        'S3 key does not match expected user prefix',
      );
    }

    const sourceName = presign.originalName || originalId || key;
    this.assertAllowedExtension(sourceName, presign.fileType as FileType);
    const expectedMimeType =
      this.normalizeContentType(presign.contentType) ??
      this.inferContentType(sourceName);
    this.assertAllowedMimeType(expectedMimeType, presign.fileType as FileType);
    assertAllowedUploadType(
      sourceName,
      expectedMimeType,
      presign.fileType as FileType,
    );

    const maxSize = await this.getMaxFileSize(
      presign.fileType as FileType,
      validationOptions,
    );
    const actualMetadata = await this.headObjectMetadata(key);
    if (!actualMetadata.exists) {
      throw new BadRequestException('Uploaded object was not found in storage');
    }
    if (
      !Number.isFinite(actualMetadata.contentLength) ||
      actualMetadata.contentLength <= 0
    ) {
      throw new BadRequestException('Uploaded object is empty or invalid');
    }
    if (actualMetadata.contentLength > maxSize) {
      this.emitUploadAlert('upload_finalize_size_limit_exceeded', 'warning', {
        presignId: id,
        actorId: userId,
        fileType: presign.fileType,
        contentLength: actualMetadata.contentLength,
        maxSize,
      });
      throw new BadRequestException('Uploaded object exceeds size limit');
    }

    const actualContentType = actualMetadata.contentType;
    if (actualContentType !== expectedMimeType) {
      this.emitUploadAlert('upload_finalize_content_type_mismatch', 'warning', {
        presignId: id,
        actorId: userId,
        fileType: presign.fileType,
        expectedMimeType,
        actualContentType,
      });
      throw new BadRequestException('Uploaded object content type mismatch');
    }

    const reportedMimeType = this.normalizeContentType(mimeType);
    if (reportedMimeType && reportedMimeType !== actualContentType) {
      this.emitUploadAlert(
        'upload_finalize_reported_type_mismatch',
        'warning',
        {
          presignId: id,
          actorId: userId,
          fileType: presign.fileType,
          reportedMimeType,
          actualContentType,
        },
      );
      throw new BadRequestException(
        'Reported file type does not match storage metadata',
      );
    }
    if (
      Number.isFinite(Number(size)) &&
      Number(size) > 0 &&
      Number(size) !== actualMetadata.contentLength
    ) {
      this.emitUploadAlert(
        'upload_finalize_reported_size_mismatch',
        'warning',
        {
          presignId: id,
          actorId: userId,
          fileType: presign.fileType,
          reportedSize: Number(size),
          actualSize: actualMetadata.contentLength,
        },
      );
      throw new BadRequestException(
        'Reported file size does not match storage metadata',
      );
    }

    return this.finalizeStoredUpload(
      presign,
      userId,
      actualMetadata,
      actualContentType,
      originalId,
    );
  }

  private async finalizeStoredUpload(
    presign: any,
    userId: string,
    metadata: S3ObjectMetadata,
    mimeType: string,
    originalId?: string,
  ): Promise<FileUpload> {
    if (!metadata.etag)
      throw new BadRequestException(
        'Storage returned no object version identifier',
      );
    const token = uuidv4();
    const targetKey = `${presign.fileType}/${userId}/final/${presign.id}/${token}.${getUploadFileExtension(presign.originalName)}`;
    const now = new Date();
    const claimed = await this.prisma.presignedUpload.updateMany({
      where: {
        id: presign.id,
        userId,
        status: { in: ['PENDING', 'READY'] },
        expiresAt: { gt: now },
        OR: [
          { finalizeLeaseUntil: null },
          { finalizeLeaseUntil: { lte: now } },
        ],
      },
      data: {
        finalizeLeaseToken: token,
        finalizeLeaseUntil: new Date(now.getTime() + 300_000),
        finalizeTargetKey: targetKey,
      },
    });
    if (!claimed.count) {
      const existing = await this.prisma.fileUpload.findUnique({
        where: { id: presign.id },
      });
      if (existing?.userId === userId) return existing;
      throw new ConflictException({
        code: 'UPLOAD_FINALIZING',
        message: 'Upload completion is in progress. Please retry shortly.',
      });
    }
    // Register cleanup before external I/O: a crash after COPY cannot strand the object.
    // The dispatcher also excludes actively leased targets before deleting anything.
    try {
      await this.prisma.storageObjectDeletion.createMany({
        data: [
          {
            s3Key: targetKey,
            nextAttemptAt: new Date(Date.now() + 86_400_000),
          },
        ],
        skipDuplicates: true,
      });
      await this.assertStoredUploadSignature(
        presign.s3Key,
        metadata.etag,
        mimeType,
        metadata.contentLength,
      );
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          Key: targetKey,
          CopySource: `${encodeURIComponent(this.bucketName)}/${presign.s3Key.split('/').map(encodeURIComponent).join('/')}`,
          CopySourceIfMatch: metadata.etag,
          MetadataDirective: 'REPLACE',
          ContentType: mimeType,
          CacheControl: 'private, max-age=300',
        }),
      );
      const record = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "_id" FROM "PresignedUpload"
          WHERE "_id" = ${presign.id}::uuid AND "userId" = ${userId}::uuid FOR UPDATE
        `;
        // A lock wait can outlive the lease. Check the DB clock in a new statement.
        const owned = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "_id" AS id FROM "PresignedUpload"
          WHERE "_id" = ${presign.id}::uuid AND "userId" = ${userId}::uuid
            AND "finalizeLeaseToken" = ${token}::uuid AND "finalizeLeaseUntil" > (clock_timestamp() AT TIME ZONE 'UTC')
            AND status IN ('PENDING', 'READY')
        `;
        if (!owned.length)
          throw new ConflictException({
            code: 'UPLOAD_FINALIZING',
            message: 'Upload completion lease expired. Please retry.',
          });
        const fileName = targetKey.split('/').pop()!;
        const created = await tx.fileUpload.create({
          data: {
            id: presign.id,
            userId,
            originalName: presign.originalName || originalId || fileName,
            fileName,
            s3Key: targetKey,
            s3Url: this.buildS3ObjectUrl(targetKey),
            fileType: presign.fileType,
            mimeType,
            size: metadata.contentLength,
            processingStatus: 'READY',
          },
        });
        await tx.presignedUpload.update({
          where: { id: presign.id },
          data: {
            status: 'USED',
            finalizedAt: new Date(),
            processingRequestedAt: mimeType.startsWith('image/')
              ? new Date()
              : null,
            finalizeLeaseToken: null,
            finalizeLeaseUntil: null,
            finalizeTargetKey: null,
          },
        });
        await tx.storageObjectDeletion.deleteMany({
          where: { s3Key: targetKey },
        });
        await tx.storageObjectDeletion.createMany({
          data: [
            {
              s3Key: presign.s3Key,
              nextAttemptAt: new Date(
                Math.max(Date.now(), new Date(presign.expiresAt).getTime()) +
                  60_000,
              ),
            },
          ],
          skipDuplicates: true,
        });
        return created;
      });
      if (mimeType.startsWith('image/'))
        await this.dispatchPresignedImageProcessing(record.id);
      return record;
    } catch (error: any) {
      if (Number(error?.$metadata?.httpStatusCode) === 412) {
        throw new ConflictException({
          code: 'UPLOAD_CHANGED',
          message:
            'The uploaded file changed during validation. Please retry completion.',
        });
      }
      throw error;
    } finally {
      await this.prisma.presignedUpload
        .updateMany({
          where: { id: presign.id, finalizeLeaseToken: token },
          data: {
            finalizeLeaseToken: null,
            finalizeLeaseUntil: null,
            finalizeTargetKey: null,
          },
        })
        .catch(() =>
          this.logger.warn(
            `Upload completion lease will expire naturally fileId=${presign.id}`,
          ),
        );
    }
  }

  private async assertStoredUploadSignature(
    key: string,
    etag: string,
    expectedMime: string,
    size: number,
  ): Promise<void> {
    // Image headers alone do not prove a decodable image. Image bytes have already
    // passed the endpoint's hard byte cap; video inspection remains prefix-bound.
    const isImage = expectedMime.startsWith('image/');
    const length =
      isImage || expectedMime.includes('wordprocessingml')
        ? size
        : Math.min(size, 65_536);
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        IfMatch: etag,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    const body = response.Body as Readable | undefined;
    if (!body)
      throw new BadRequestException('Uploaded object has no readable content');
    try {
      // Node 22 loads this ESM package through require; keep it off non-upload paths.
      const { fileTypeFromStream, fileTypeFromBuffer } = createRequire(
        __filename,
      )('file-type') as typeof import('file-type');
      let imageBytes: Buffer | undefined;
      if (isImage) {
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of body) {
          received += chunk.length;
          if (received > size)
            throw new BadRequestException(
              'Uploaded image exceeds its validated size',
            );
          chunks.push(Buffer.from(chunk));
        }
        if (received !== size)
          throw new BadRequestException('Uploaded image is incomplete');
        imageBytes = Buffer.concat(chunks, received);
      }
      const detected = imageBytes
        ? await fileTypeFromBuffer(imageBytes)
        : await fileTypeFromStream(body);
      const compoundWord =
        expectedMime === 'application/msword' &&
        detected?.mime === 'application/x-cfb';
      if (
        !detected ||
        (!compoundWord &&
          normalizeUploadContentType(detected.mime) !== expectedMime)
      ) {
        throw new BadRequestException(
          'Uploaded bytes do not match the selected file type',
        );
      }
      if (imageBytes) await assertCompleteRasterImage(imageBytes);
    } finally {
      body.destroy();
    }
  }

  async dispatchPresignedImageProcessing(fileId: string): Promise<void> {
    const sent = await this.enqueueImageProcessing(fileId, true);
    if (sent)
      await this.prisma.presignedUpload.updateMany({
        where: { id: fileId, status: 'USED', processingEnqueuedAt: null },
        data: { processingEnqueuedAt: new Date() },
      });
  }

  private emitUploadAlert(
    event: string,
    severity: 'info' | 'warning' | 'error' | 'critical',
    metadata: Record<string, unknown>,
  ): void {
    this.monitoring?.emitAlert({
      category: 'UPLOAD',
      severity,
      event,
      message: event,
      actorId:
        typeof metadata.actorId === 'string' ? metadata.actorId : undefined,
      entityType: 'FileUpload',
      entityId:
        typeof metadata.presignId === 'string' ? metadata.presignId : undefined,
      metadata,
    });
  }

  private hashStorageKey(key: string | null | undefined): string {
    return createHash('sha256')
      .update(String(key ?? ''))
      .digest('hex')
      .slice(0, 16);
  }

  // Helper for server-side tests: upload a buffer directly to S3 and create FileUpload record
  async uploadBufferDirect(
    userId: string,
    originalName: string,
    buffer: Buffer,
    mimeType: string,
    fileType: FileType,
  ) {
    return this.storeServerUpload(
      {
        originalname: originalName,
        buffer,
        size: buffer.length,
        mimetype: mimeType,
      } as Express.Multer.File,
      userId,
      fileType,
    );
  }

  async getFileVariants(fileId: string, userId: string) {
    if (!userId) throw new ForbiddenException('Authentication required');
    const file = await this.prisma.fileUpload.findFirst({
      where: { id: fileId, userId },
    });
    if (!file) {
      throw new BadRequestException('File not found');
    }

    if (!this.isDisplayableStoredFile(file))
      return {
        fileId: file.id,
        processingStatus: file.processingStatus,
        version: file.assetVersion,
        variants: {},
        fallbackUrl: null,
        s3Url: null,
      };
    const variantRows = await (this.prisma as any).fileVariant.findMany({
      where: {
        fileUploadId: fileId,
        assetVersion: (file as any).assetVersion ?? 1,
      },
      orderBy: [{ variantKind: 'asc' }, { format: 'asc' }],
    });

    const variants: VariantsMap = {};
    for (const row of variantRows ?? []) {
      const key = String(row.variantKind || '').toLowerCase();
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
        url: await this.getTemporarySignedDisplayUrl(
          { s3Key: row.s3Key },
          3600,
        ),
        width: row.width,
        height: row.height,
        format: row.format,
      } as VariantView;
    }

    const fallbackUrl = await this.getTemporarySignedDisplayUrl(file, 3600);
    return {
      fileId: file.id,
      processingStatus: (file as any).processingStatus ?? 'READY',
      version: (file as any).assetVersion ?? 1,
      variants,
      fallbackUrl,
      s3Url: fallbackUrl,
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

    // Keep a published version readable while the replacement is encoded.
    if (!(await this.enqueueImageProcessing(fileId, true))) {
      throw new ServiceUnavailableException(
        'Image processing is temporarily unavailable. Please retry.',
      );
    }
    return { fileId, processingStatus: 'PENDING' };
  }

  async enqueueImageProcessing(
    fileId: string,
    force = false,
  ): Promise<boolean> {
    if (!fileId || !this.imageQueue || !this.isImageOptimizationEnabled()) {
      return false;
    }
    try {
      await this.imageQueue.enqueueSingle(fileId, force);
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue image processing for ${fileId}: ${String(error)}`,
      );
      return false;
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
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        CacheControl: 'private, max-age=300',
      }),
    );
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
    for await (const chunk of body as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
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
    return String(mimeType || '')
      .toLowerCase()
      .startsWith('image/');
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

  private async validateFile(
    file: Express.Multer.File,
    fileType: FileType,
    validationOptions: UploadValidationOptions = {},
  ): Promise<void> {
    const maxSize = await this.getMaxFileSize(fileType, validationOptions);
    this.assertAllowedExtension(file.originalname, fileType);
    const trustedMimeType = this.normalizeContentType(file.mimetype);
    this.assertAllowedMimeType(trustedMimeType, fileType);
    assertAllowedUploadType(file.originalname, trustedMimeType, fileType);

    if (file.size > maxSize) {
      const limitMB = formatUploadLimitMB(maxSize);
      throw new BadRequestException(
        `File size exceeds the ${limitMB}MB limit for ${fileType}`,
      );
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
