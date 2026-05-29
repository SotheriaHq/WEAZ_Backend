import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { DesignsService } from './designs.service';
import { FinalizeDesignUploadDto } from './dto/finalize-design-upload.dto';
import {
  InitializeDesignMediaUploadDto,
  InitializeDesignUploadDto,
  ReorderDesignMediaDto,
} from './dto/initialize-design-upload.dto';
import { UpdateDesignDto } from './dto/update-design.dto';

@ApiTags('designs')
@ApiBearerAuth()
@Controller('designs')
export class DesignsController {
  constructor(private readonly designsService: DesignsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  async initializeDesign(
    @Req() req: any,
    @Body() dto: InitializeDesignUploadDto,
  ) {
    return this.designsService.initializeDesignUpload(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/finalize')
  async finalizeDesign(
    @Param('id') designId: string,
    @Req() req: any,
    @Body() dto: FinalizeDesignUploadDto,
  ) {
    return this.designsService.finalizeDesignUpload(designId, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/media/initialize')
  async initializeDesignMediaUploads(
    @Param('id') designId: string,
    @Req() req: any,
    @Body() dto: InitializeDesignMediaUploadDto,
  ) {
    return this.designsService.initializeDesignMediaUpload(
      designId,
      req.user.id,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/reorder-media')
  async reorderDesignMedia(
    @Param('id') designId: string,
    @Req() req: any,
    @Body() dto: ReorderDesignMediaDto,
  ) {
    return this.designsService.reorderDesignMedia(
      designId,
      req.user.id,
      dto.items,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/media/:mediaId')
  async deleteDesignMedia(
    @Param('id') designId: string,
    @Param('mediaId') mediaId: string,
    @Req() req: any,
  ) {
    return this.designsService.deleteDesignMedia(
      designId,
      mediaId,
      req.user.id,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/drafts')
  async getMyDraftDesigns(@Req() req: any) {
    return this.designsService.getMyDraftDesigns(req.user.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('user/:userId')
  async getUserDesigns(
    @Param('userId') userId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('visibility') visibility?: 'public' | 'private' | 'all',
    @Query('includeDeleted') includeDeleted?: string,
    @Query('onlyDeleted') onlyDeleted?: string,
    @Req() req?: any,
  ) {
    return this.designsService.getUserDesigns(userId, req?.user?.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      visibility,
      includeDeleted: includeDeleted === 'true' || includeDeleted === '1',
      onlyDeleted: onlyDeleted === 'true' || onlyDeleted === '1',
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async getDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.getDesignDetail(designId, req.user?.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateDesign(
    @Param('id') designId: string,
    @Req() req: any,
    @Body() dto: UpdateDesignDto,
  ) {
    return this.designsService.updateDesign(designId, req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/archive')
  async archiveDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.archiveDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/unarchive')
  async unarchiveDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.unarchiveDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.deleteDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/restore')
  async restoreDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.restoreDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/permanent')
  async permanentlyDeleteDesign(
    @Param('id') designId: string,
    @Req() req: any,
  ) {
    return this.designsService.permanentlyDeleteDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  async duplicateDesign(@Param('id') designId: string, @Req() req: any) {
    return this.designsService.duplicateDesign(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/draft-session')
  async startDesignDraftSession(
    @Param('id') designId: string,
    @Body()
    body: { deviceName?: string; forceNew?: boolean; existingToken?: string },
    @Req() req: any,
  ) {
    return this.designsService.startDesignDraftSession(
      designId,
      req.user.id,
      body,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/custom-fit-inquiry')
  async submitDesignCustomFitInquiry(
    @Param('id') designId: string,
    @Body()
    body: {
      productId?: string;
      message: string;
      measurements?: string;
      preferredSize?: string;
    },
    @Req() req: any,
  ) {
    return this.designsService.submitDesignCustomFitInquiry(
      designId,
      req.user.id,
      body,
    );
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/custom-order-configuration')
  async getDesignCustomOrderConfiguration(
    @Param('id') designId: string,
    @Req() req: any,
  ) {
    return this.designsService.getDesignCustomOrderConfiguration(
      designId,
      req.user?.id,
    );
  }
}
