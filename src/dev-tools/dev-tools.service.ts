import { Injectable } from '@nestjs/common';

@Injectable()
export class DevToolsService {
  extractMetadataFromUploads(files: Array<Express.Multer.File>) {
    return files.map((file) => ({
      name: file.originalname,
      type: file.mimetype,
      size: file.size,
    }));
  }
}
