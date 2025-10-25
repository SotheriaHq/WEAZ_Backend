import { FileType } from '@prisma/client';
import { FileSpecDto } from '../dto/create-collection.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { UploadService } from 'src/upload/upload.service';

@Injectable()
export class HelperService {
  constructor(private readonly uploadService: UploadService) {}

  public validateFileSpec(fileSpec: FileSpecDto, fileType: FileType) {
    const maxSizes = {
      [FileType.POST_IMAGE]: 10 * 1024 * 1024, // 10MB
      [FileType.POST_VIDEO]: 100 * 1024 * 1024, // 100MB
      [FileType.DOCUMENT]: 20 * 1024 * 1024, // 20MB
      [FileType.PROFILE_IMAGE]: 5 * 1024 * 1024, // 5MB
      [FileType.BANNER_IMAGE]: 8 * 1024 * 1024, // 8MB
    };

    if (fileSpec.size > maxSizes[fileType]) {
      throw new BadRequestException(
        `File ${fileSpec.name} exceeds size limit for ${fileType}`,
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
  ) {
    // UploadService will create a presigned DB entry and return url/fields
    return this.uploadService.createPresignedPost(
      userId,
      originalName,
      fileType as any,
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
