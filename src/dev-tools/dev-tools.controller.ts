import {
  Controller,
  Get,
  Post,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { isSentryEnabled } from 'src/common/observability/sentry.instrument';
import { FilesInterceptor } from '@nestjs/platform-express';
import { DevToolsService } from './dev-tools.service';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';

// Dev-only module (not loaded in hard production); left open for local use.
@IsPublic()
@Controller('dev-tools')
export class DevToolsController {
  constructor(private readonly devToolsService: DevToolsService) {}

  @Get('debug-sentry')
  @ApiOperation({
    summary: 'DEV ONLY: Throws a test error to verify Sentry wiring',
  })
  debugSentry() {
    if (!isSentryEnabled()) {
      throw new ForbiddenException(
        'Sentry is not initialised. Set SENTRY_DSN before using this endpoint.',
      );
    }
    Sentry.logger.info('User triggered test error', {
      action: 'test_error_endpoint',
    });
    Sentry.metrics.count('test_counter', 1);
    throw new Error('My first Sentry error!');
  }

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
