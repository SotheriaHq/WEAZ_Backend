import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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

export interface FileUploadResult {
  id: string;
  url: string;
  key: string;
  fileName: string;
  originalName: string;
  size: number;
  mimeType: string;
  fileType: FileType;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3: S3Client;
  private readonly bucketName: string;
  private readonly region: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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

  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    fileType: FileType,
  ): Promise<FileUploadResult> {
    this.validateFile(file, fileType);

    const fileId = uuidv4();
    const key = this.generateS3Key(fileType, userId, fileId, file.originalname);

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
      const s3Url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;

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
        },
      });

      return {
        id: uploadRecord.id,
        url: uploadRecord.s3Url,
        key: uploadRecord.s3Key,
        fileName: uploadRecord.fileName,
        originalName: uploadRecord.originalName,
        size: uploadRecord.size,
        mimeType: uploadRecord.mimeType,
        fileType: uploadRecord.fileType as FileType,
        createdAt: uploadRecord.createdAt.toISOString(),
        updatedAt: uploadRecord.updatedAt.toISOString(),
      };
    } catch (error) {
      this.logger.error('File upload failed:', error);
      this.logger.error('File upload error details:', error);
      throw new BadRequestException('File upload failed');
    }
  }

  // Generate presigned POST data for client direct-to-S3 uploads
  async createPresignedPost(
    userId: string,
    originalName: string,
    fileType: FileType,
    contentType?: string,
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
    const region = this.region;
    const uploadUrl = `https://${this.bucketName}.s3.${region}.amazonaws.com`;

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
    await this.prisma.user.update({
      where: { id: userId },
      data: { profileImageId: file.id, profileImage: file.url },
    });
  }

  async updateUserBannerImage(
    userId: string,
    file: Pick<FileUploadResult, 'id' | 'url'>,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { bannerImageId: file.id, bannerImage: file.url },
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
    });

    if (!file) {
      return null;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: file.s3Key,
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
      select: { id: true, s3Key: true },
    });

    const urlMap = new Map<string, string>();

    for (const file of files) {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: file.s3Key,
      });
      const signedUrl = await getSignedUrl(this.s3, command, {
        expiresIn: 3600,
      }); // 1 hour
      urlMap.set(file.id, signedUrl);
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
      this.logger.warn('S3 headObject failed for key:', key, err);
      return false;
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

    // Mark presign as USED
    await (this.prisma as any)['presignedUpload'].update({
      where: { id },
      data: { status: 'USED' },
    } as any);

    const fileName = key.split('/').pop() || key;
    const region =
      (this.s3.config && (this.s3.config as any).region) || this.region;
    const url = `https://${this.bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(key)}`;

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
      },
    });

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
    const s3Url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;

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
      },
    });
    return record;
  }

  private validateFile(file: Express.Multer.File, fileType: FileType): void {
    const maxSizes = {
      [FileType.PROFILE_IMAGE]: 5 * 1024 * 1024, // 5MB
      [FileType.BANNER_IMAGE]: 8 * 1024 * 1024, // 8MB
      [FileType.POST_IMAGE]: 10 * 1024 * 1024, // 10MB
      [FileType.POST_VIDEO]: 100 * 1024 * 1024, // 100MB
      [FileType.DOCUMENT]: 20 * 1024 * 1024, // 20MB
    };

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
      [FileType.DOCUMENT]: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    };

    if (file.size > maxSizes[fileType]) {
      throw new BadRequestException(`File size exceeds limit for ${fileType}`);
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
