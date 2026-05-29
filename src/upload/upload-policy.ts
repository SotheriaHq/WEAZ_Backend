import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { FileType } from './upload.enums';

const MB = 1024 * 1024;

export const UPLOAD_ALLOWED_MIME_TYPES: Record<FileType, readonly string[]> = {
  [FileType.PROFILE_IMAGE]: ['image/jpeg', 'image/png', 'image/webp'],
  [FileType.BANNER_IMAGE]: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ],
  [FileType.POST_IMAGE]: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
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

export const UPLOAD_ALLOWED_EXTENSIONS: Record<FileType, readonly string[]> = {
  [FileType.PROFILE_IMAGE]: ['jpg', 'jpeg', 'png', 'webp'],
  [FileType.BANNER_IMAGE]: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  [FileType.POST_IMAGE]: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  [FileType.POST_VIDEO]: ['mp4', 'webm', 'mov'],
  [FileType.REVIEW_IMAGE]: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  [FileType.REVIEW_VIDEO]: ['mp4', 'webm', 'mov'],
  [FileType.DOCUMENT]: ['pdf', 'doc', 'docx'],
  [FileType.BRAND_VERIFICATION]: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  [FileType.MESSAGE_IMAGE]: ['jpg', 'jpeg', 'png', 'webp'],
  [FileType.MESSAGE_DOCUMENT]: ['pdf'],
};

export const UPLOAD_EXTENSION_MIME_HINTS: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const DIRECT_UPLOAD_HARD_LIMIT_BYTES: Record<FileType, number> = {
  [FileType.PROFILE_IMAGE]: 5 * MB,
  [FileType.BANNER_IMAGE]: 5 * MB,
  [FileType.POST_IMAGE]: 8 * MB,
  [FileType.POST_VIDEO]: 100 * MB,
  [FileType.REVIEW_IMAGE]: 10 * MB,
  [FileType.REVIEW_VIDEO]: 50 * MB,
  [FileType.DOCUMENT]: 10 * MB,
  [FileType.BRAND_VERIFICATION]: 10 * MB,
  [FileType.MESSAGE_IMAGE]: 10 * MB,
  [FileType.MESSAGE_DOCUMENT]: 10 * MB,
};

export const COLLECTION_BULK_UPLOAD_HARD_LIMIT_BYTES = 10 * MB;

const COLLECTION_BULK_ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
]);

const COLLECTION_BULK_ALLOWED_EXTENSIONS = new Set(['csv']);

export function normalizeUploadContentType(
  contentType?: string | null,
): string | null {
  const value = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return value || null;
}

export function getUploadFileExtension(fileName: string): string {
  return path
    .extname(String(fileName ?? ''))
    .replace('.', '')
    .toLowerCase();
}

export function inferUploadContentType(fileName: string): string | null {
  return UPLOAD_EXTENSION_MIME_HINTS[getUploadFileExtension(fileName)] ?? null;
}

export function assertAllowedUploadExtension(
  originalName: string,
  fileType: FileType,
): void {
  const extension = getUploadFileExtension(originalName);
  const allowed = UPLOAD_ALLOWED_EXTENSIONS[fileType] ?? [];
  if (!extension || !allowed.includes(extension)) {
    throw new BadRequestException(`File extension not allowed for ${fileType}`);
  }
}

export function assertAllowedUploadMimeType(
  mimeType: string | null,
  fileType: FileType,
): asserts mimeType is string {
  if (!mimeType || !UPLOAD_ALLOWED_MIME_TYPES[fileType]?.includes(mimeType)) {
    throw new BadRequestException(`File type not allowed for ${fileType}`);
  }
}

export function formatUploadLimitMB(limitBytes: number): string {
  const mb = limitBytes / MB;
  return mb % 1 === 0 ? String(mb) : mb.toFixed(1);
}

function validateMulterFileShape(
  file: Pick<Express.Multer.File, 'originalname' | 'mimetype'>,
  fileType: FileType,
): void {
  assertAllowedUploadExtension(file.originalname, fileType);
  const trustedMimeType = normalizeUploadContentType(file.mimetype);
  assertAllowedUploadMimeType(trustedMimeType, fileType);
}

export function multerOptionsForFileType(fileType: FileType): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: {
      fileSize: DIRECT_UPLOAD_HARD_LIMIT_BYTES[fileType],
      files: 1,
    },
    fileFilter: (_req, file, callback) => {
      try {
        validateMulterFileShape(file, fileType);
        callback(null, true);
      } catch (error) {
        callback(error as Error, false);
      }
    },
  };
}

export function collectionBulkUploadMulterOptions(): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: {
      fileSize: COLLECTION_BULK_UPLOAD_HARD_LIMIT_BYTES,
      files: 1,
    },
    fileFilter: (_req, file, callback) => {
      const extension = getUploadFileExtension(file.originalname);
      const contentType = normalizeUploadContentType(file.mimetype);
      const validExtension = COLLECTION_BULK_ALLOWED_EXTENSIONS.has(extension);
      const validMime =
        !contentType ||
        contentType === 'application/octet-stream' ||
        COLLECTION_BULK_ALLOWED_MIME_TYPES.has(contentType);

      if (!validExtension || !validMime) {
        callback(
          new BadRequestException('Bulk upload requires a CSV file'),
          false,
        );
        return;
      }

      callback(null, true);
    },
  };
}
