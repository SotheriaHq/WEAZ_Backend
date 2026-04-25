import { FileType } from '@prisma/client';
import { FileSpecDto } from '../dto/create-collection.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { UploadService } from 'src/upload/upload.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';

const FILE_TYPE_CONFIG_KEYS: Record<string, string> = {
  [FileType.POST_IMAGE]: 'upload.maxSize.postImage',
  [FileType.POST_VIDEO]: 'upload.maxSize.postVideo',
  [FileType.DOCUMENT]: 'upload.maxSize.document',
  [FileType.PROFILE_IMAGE]: 'upload.maxSize.profileImage',
  [FileType.BANNER_IMAGE]: 'upload.maxSize.bannerImage',
};

@Injectable()
export class HelperService {
  constructor(
    private readonly uploadService: UploadService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  public async validateFileSpec(fileSpec: FileSpecDto, fileType: FileType) {
    const configKey = FILE_TYPE_CONFIG_KEYS[fileType];
    const maxSize = configKey
      ? await this.systemConfigService.getMaxFileSize(configKey)
      : 2 * 1024 * 1024;

    if (fileSpec.size > maxSize) {
      const limitMB = (maxSize / (1024 * 1024)).toFixed(1);
      throw new BadRequestException(
        `File ${fileSpec.name} exceeds the ${limitMB}MB limit for ${fileType}`,
      );
    }

    const allowedMimes = {
      [FileType.POST_IMAGE]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ],
      [FileType.POST_VIDEO]: ['video/mp4', 'video/webm', 'video/quicktime'],
      [FileType.DOCUMENT]: ['application/pdf'],
      [FileType.PROFILE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
      [FileType.BANNER_IMAGE]: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ],
    };

    if (!allowedMimes[fileType].includes(fileSpec.type)) {
      throw new BadRequestException(
        `File type ${fileSpec.type} not allowed for ${fileType}`,
      );
    }
  }

  public determineFileType(mimeType: string, hint?: FileType): FileType {
    if (hint) return hint;

    if (mimeType.startsWith('image/')) return FileType.POST_IMAGE;
    if (mimeType.startsWith('video/')) return FileType.POST_VIDEO;
    if (mimeType === 'application/pdf') return FileType.DOCUMENT;

    return FileType.POST_IMAGE; // fallback
  }

  public determineFileTypeFromKey(s3Key: string): FileType {
    if (s3Key.startsWith('POST_IMAGE/')) return FileType.POST_IMAGE;
    if (s3Key.startsWith('POST_VIDEO/')) return FileType.POST_VIDEO;
    if (s3Key.startsWith('DOCUMENT/')) return FileType.DOCUMENT;
    return FileType.POST_IMAGE;
  }

  public generateS3Key(
    fileType: FileType,
    userId: string,
    fileId: string,
    originalName: string,
  ): string {
    const extension = originalName.split('.').pop()?.toLowerCase() || '';
    const timestamp = Date.now();
    return `${fileType}/${userId}/${timestamp}-${fileId}.${extension}`;
  }

  /**
   * Delegate presign creation to UploadService.
   * Returns the same shape as UploadService.createPresignedPost
   */
  public async createPresignedUrl(
    userId: string,
    originalName: string,
    fileType: FileType,
    options?: { collectionId?: string; orderIndex?: number },
  ) {
    // UploadService will create a presigned DB entry and return url/fields
    return this.uploadService.createPresignedPost(
      userId,
      originalName,
      fileType as any,
      undefined,
      options,
    );
  }

  /**
   * Verify S3 object existence via UploadService
   */
  public async verifyS3Object(s3Key: string): Promise<boolean> {
    return this.uploadService.verifyObjectExists(s3Key);
  }

  public hashIP(ip: string): string {
    // Simple hash for privacy - use crypto.createHash in real implementation
    return Buffer.from(ip).toString('base64');
  }
}
