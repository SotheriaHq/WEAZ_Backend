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
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { UploadService } from './upload.service';
import { FileType } from './upload.enums';
import { GetFilesDto } from './dto/get-files.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { multerOptionsForFileType } from './upload-policy';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  constructor(private uploadService: UploadService) { }

  // ============================================
  // PUBLIC ENDPOINTS (No Auth Required)
  // ============================================

  @Get('public-url/:fileId')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
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
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
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
    if (!url) {
      throw new BadRequestException('File not found');
    }
    return { url };
  }

  // ============================================
  // AUTHENTICATED ENDPOINTS
  // ============================================

  @UseGuards(JwtAuthGuard)
  @Post('profile-image')
  @ApiOperation({ summary: 'Upload profile image' })
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.PROFILE_IMAGE)))
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
    // Update user's profile image reference
    await this.uploadService.updateUserProfileImage(req.user.id, result);

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Delete('profile-image')
  @ApiOperation({ summary: 'Remove profile image' })
  async removeProfileImage(@Req() req: any) {
    await this.uploadService.clearUserProfileImage(req.user.id);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('banner-image')
  @ApiOperation({ summary: 'Upload banner image' })
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.BANNER_IMAGE)))
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
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.POST_IMAGE)))
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
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.POST_VIDEO)))
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
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.REVIEW_IMAGE)))
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
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.REVIEW_VIDEO)))
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
  @Post('message-image')
  @ApiOperation({ summary: 'Upload message image attachment' })
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.MESSAGE_IMAGE)))
  async uploadMessageImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.MESSAGE_IMAGE,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('message-document')
  @ApiOperation({ summary: 'Upload message document attachment' })
  @UseInterceptors(FileInterceptor('file', multerOptionsForFileType(FileType.MESSAGE_DOCUMENT)))
  async uploadMessageDocument(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    return this.uploadService.uploadFile(
      file,
      req.user.id,
      FileType.MESSAGE_DOCUMENT,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-files')
  @ApiOperation({ summary: 'Get user files with pagination' })
  async getUserFiles(@Req() req: any, @Query() query: GetFilesDto) {
    return this.uploadService.getUserFiles(req.user.id, query);
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 240, ttl: 60000 } })
  @Get('signed-url/:fileId')
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
