import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { DevToolsService } from './dev-tools.service';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

@ApiTags('Development Tools')
@Controller('dev-tools')
export class DevToolsController {
  constructor(private readonly devToolsService: DevToolsService) {}

  @Post('extract-metadata')
  @UseInterceptors(FilesInterceptor('file', 20)) // Allow up to 20 files with the key 'file'
  @ApiOperation({
    summary: 'DEV ONLY: Extracts metadata from one or more uploaded files',
    description:
      'Upload files directly to get their metadata (name, type, size) as a JSON array. THIS IS FOR DEVELOPMENT USE ONLY.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'The file(s) to analyze',
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
        },
      },
    },
  })
  extractMetadata(@UploadedFiles() files: Array<Express.Multer.File>) {
    if (!files || files.length === 0) {
      throw new BadRequestException(
        "No files uploaded. Please use the 'file' key.",
      );
    }
    return this.devToolsService.extractMetadataFromUploads(files);
  }
}
