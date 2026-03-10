import {
  Controller,
  Post,
  Get,
  Delete,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Req,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UploadService } from './upload.service';
import { FileType } from './upload.enums';
import { GetFilesDto } from './dto/get-files.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  constructor(private uploadService: UploadService) { }

  // ============================================
  // PUBLIC ENDPOINTS (No Auth Required)
  // ============================================

  @Get('public-url/:fileId')
  @SkipThrottle()
  @ApiOperation({
    summary: 'Get public signed URL for file access (no auth required)',
    description:
      'Returns signed URL for publicly accessible files such as published collection media',
  })
  async getPublicSignedUrl(@Param('fileId') fileId: string) {
    const url = await this.uploadService.getPublicSignedUrl(fileId);
    if (!url) {
      throw new BadRequestException('File not found');
    }
    return { url };
  }

  @Get('public-url-by-key')
  @SkipThrottle()
  @ApiOperation({
    summary: 'Get public signed URL by S3 key (no auth required)',
    description:
      'Returns signed URL for an S3 object by its key. Used for raw S3 URLs that lack a FileUpload record.',
  })
  async getPublicSignedUrlByKey(@Query('key') key: string) {
    if (!key || typeof key !== 'string' || key.includes('..')) {
      throw new BadRequestException('Invalid S3 key');
    }
    const url = await this.uploadService.getPublicSignedUrlByKey(key);
    return { url };
  }

  // ============================================
  // AUTHENTICATED ENDPOINTS
  // ============================================

  @UseGuards(JwtAuthGuard)
  @Post('profile-image')
  @ApiOperation({ summary: 'Upload profile image' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadProfileImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const result = await this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.PROFILE_IMAGE,
    );
    console.log(
      `Profile image uploaded for user ${req.user.id}: ${result.url}`,
    );

    // Update user's profile image reference
    await this.uploadService.updateUserProfileImage(req.user.id, result);

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Post('banner-image')
  @ApiOperation({ summary: 'Upload banner image' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadBannerImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const result = await this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.BANNER_IMAGE,
    );

    await this.uploadService.updateUserBannerImage(req.user.id, result);
    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Post('post-image')
  @ApiOperation({ summary: 'Upload post image' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadPostImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.POST_IMAGE,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('post-video')
  @ApiOperation({ summary: 'Upload post video' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadPostVideo(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.POST_VIDEO,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('review-image')
  @ApiOperation({ summary: 'Upload review image' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadReviewImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.REVIEW_IMAGE,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('review-video')
  @ApiOperation({ summary: 'Upload review video' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadReviewVideo(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.REVIEW_VIDEO,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-files')
  @ApiOperation({ summary: 'Get user files with pagination' })
  async getUserFiles(@Req() req: any, @Query() query: GetFilesDto) {
    return this.uploadService.getUserFiles(req.user.id, query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('signed-url/:fileId')
  @SkipThrottle()
  @ApiOperation({ summary: 'Get signed URL for file access' })
  async getSignedUrl(@Param('fileId') fileId: string, @Req() req: any) {
    const url = await this.uploadService.getSignedUrl(fileId, req.user.id);
    return { url };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':fileId/variants')
  @ApiOperation({ summary: 'Get optimized image variants for a file' })
  async getVariants(@Param('fileId') fileId: string, @Req() req: any) {
    return this.uploadService.getFileVariants(fileId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':fileId/reprocess')
  @ApiOperation({ summary: 'Enqueue image variant reprocessing for a file' })
  async reprocess(@Param('fileId') fileId: string, @Req() req: any) {
    return this.uploadService.reprocessFile(fileId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':fileId')
  @ApiOperation({ summary: 'Delete file' })
  async deleteFile(@Param('fileId') fileId: string, @Req() req: any) {
    await this.uploadService.deleteFile(fileId, req.user.id);
    return { message: 'File deleted successfully' };
  }
}
