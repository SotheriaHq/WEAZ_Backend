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
import { UserType } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import {
  CollectionsService,
  CreateCollectionDto,
  FinalizeCollectionDto,
} from './collections.service';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@ApiTags('designs')
@ApiBearerAuth()
@Controller('designs')
export class DesignsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('initialize')
  async initializeDesign(@Req() req: any, @Body() dto: CreateCollectionDto) {
    const payload: CreateCollectionDto = {
      ...dto,
      mode: undefined,
      isAvailableInStore: false,
    };
    return this.collectionsService.initializeCollection(req.user.id, payload);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':designId/finalize')
  async finalizeDesign(
    @Param('designId') designId: string,
    @Req() req: any,
    @Body() dto: FinalizeCollectionDto,
  ) {
    return this.collectionsService.finalizeCollection(
      designId,
      req.user.id,
      dto,
      'design',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/drafts')
  async getMyDraftDesigns(@Req() req: any) {
    return this.collectionsService.getMyDraftCollections(req.user.id);
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
    return this.collectionsService.getUserCollections(userId, req?.user?.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      visibility,
      scope: 'design',
      includeDeleted:
        includeDeleted === 'true' || includeDeleted === '1',
      onlyDeleted: onlyDeleted === 'true' || onlyDeleted === '1',
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async getDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.getCollection(designId, req.user?.id, 'design');
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id')
  async updateDesign(
    @Param('id') designId: string,
    @Req() req: any,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionsService.updateCollection(designId, req.user.id, dto, 'design');
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id/archive')
  async archiveDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.archiveCollection(designId, req.user.id, 'design');
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id/unarchive')
  async unarchiveDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.unarchiveCollection(designId, req.user.id, 'design');
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id')
  async deleteDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.deleteCollection(designId, req.user.id, 'design');
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/restore')
  async restoreDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.restoreCollection(designId, req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id/permanent')
  async permanentlyDeleteDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.permanentlyDeleteCollection(
      designId,
      req.user.id,
      'design',
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/duplicate')
  async duplicateDesign(@Param('id') designId: string, @Req() req: any) {
    return this.collectionsService.duplicateCollection(designId, req.user.id, 'design');
  }
}
