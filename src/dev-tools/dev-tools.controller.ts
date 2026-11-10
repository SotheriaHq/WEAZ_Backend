import {
  Controller,
  Get,
  Post,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { isSentryEnabled } from 'src/common/observability/sentry.instrument';
import { FilesInterceptor } from '@nestjs/platform-express';
import { DevToolsService } from './dev-tools.service';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';
import { DIRECT_UPLOAD_HARD_LIMIT_BYTES } from 'src/upload/upload-policy';
import { FileType } from 'src/upload/upload.enums';
import { metadataOnlyUploadStorage } from './metadata-only-upload.storage';
import { ReadOnlyResponse } from 'src/auth/decorator/read-only-response.decorator';
import { Throttle } from '@nestjs/throttler';

// Excluded from hard production, but SIT is also internet-facing. Diagnostics
// retain their functions behind the current privileged session and MFA gate.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SuperAdmin)
@Controller('dev-tools')
export class DevToolsController {
  constructor(private readonly devToolsService: DevToolsService) {}

  @Get('debug-sentry')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
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
  @ReadOnlyResponse()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(FilesInterceptor('file', 20, { storage: metadataOnlyUploadStorage, limits: {
    files: 20, fields: 0, parts: 20, fileSize: DIRECT_UPLOAD_HARD_LIMIT_BYTES[FileType.POST_IMAGE],
  } }))
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
