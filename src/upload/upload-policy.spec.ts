import { BadRequestException } from '@nestjs/common';
import { FileType } from './upload.enums';
import {
  COLLECTION_BULK_UPLOAD_HARD_LIMIT_BYTES,
  DIRECT_UPLOAD_HARD_LIMIT_BYTES,
  collectionBulkUploadMulterOptions,
  multerOptionsForFileType,
} from './upload-policy';

const makeFile = (
  partial: Partial<Express.Multer.File>,
): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'avatar.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('file'),
    ...partial,
  }) as Express.Multer.File;

const runFileFilter = async (
  options: ReturnType<typeof multerOptionsForFileType>,
  file: Express.Multer.File,
) =>
  new Promise<{ error: unknown; accepted: boolean | undefined }>((resolve) => {
    options.fileFilter?.({} as any, file, (error, accepted) => {
      resolve({ error, accepted });
    });
  });

describe('upload multer policy', () => {
  it('adds pre-buffer size and single-file limits for profile uploads', () => {
    const options = multerOptionsForFileType(FileType.PROFILE_IMAGE);

    expect(options.storage).toBeDefined();
    expect(options.limits?.files).toBe(1);
    expect(options.limits?.fileSize).toBe(
      DIRECT_UPLOAD_HARD_LIMIT_BYTES[FileType.PROFILE_IMAGE],
    );
  });

  it('accepts a matching MIME type and extension before service storage', async () => {
    const options = multerOptionsForFileType(FileType.PROFILE_IMAGE);
    const result = await runFileFilter(
      options,
      makeFile({ originalname: 'avatar.webp', mimetype: 'image/webp' }),
    );

    expect(result.error).toBeNull();
    expect(result.accepted).toBe(true);
  });

  it('rejects invalid MIME types before service storage', async () => {
    const options = multerOptionsForFileType(FileType.PROFILE_IMAGE);
    const result = await runFileFilter(
      options,
      makeFile({ originalname: 'avatar.jpg', mimetype: 'text/plain' }),
    );

    expect(result.error).toBeInstanceOf(BadRequestException);
    expect(result.accepted).toBe(false);
  });

  it('rejects invalid extensions before service storage', async () => {
    const options = multerOptionsForFileType(FileType.MESSAGE_DOCUMENT);
    const result = await runFileFilter(
      options,
      makeFile({ originalname: 'payload.exe', mimetype: 'application/pdf' }),
    );

    expect(result.error).toBeInstanceOf(BadRequestException);
    expect(result.accepted).toBe(false);
  });

  it('adds hard limits and CSV filtering for collection bulk uploads', async () => {
    const options = collectionBulkUploadMulterOptions();

    expect(options.limits?.files).toBe(1);
    expect(options.limits?.fileSize).toBe(COLLECTION_BULK_UPLOAD_HARD_LIMIT_BYTES);

    const valid = await new Promise<{ error: unknown; accepted: boolean | undefined }>(
      (resolve) => {
        options.fileFilter?.(
          {} as any,
          makeFile({ originalname: 'products.csv', mimetype: 'text/csv' }),
          (error, accepted) => resolve({ error, accepted }),
        );
      },
    );
    expect(valid.error).toBeNull();
    expect(valid.accepted).toBe(true);

    const invalid = await new Promise<{ error: unknown; accepted: boolean | undefined }>(
      (resolve) => {
        options.fileFilter?.(
          {} as any,
          makeFile({ originalname: 'products.pdf', mimetype: 'application/pdf' }),
          (error, accepted) => resolve({ error, accepted }),
        );
      },
    );
    expect(invalid.error).toBeInstanceOf(BadRequestException);
    expect(invalid.accepted).toBe(false);
  });
});
