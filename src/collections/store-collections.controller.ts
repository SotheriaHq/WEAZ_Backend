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
import {
  CollectionsService,
  CreateCollectionDto,
  FinalizeCollectionDto,
} from './collections.service';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import {
  AddProductsDto,
  ApplyTemplateDto,
  ReorderCollectionProductsDto,
} from './dto/collection-products.dto';
import { CreateProductDto } from 'src/store/dto/create-product.dto';

@ApiTags('store-collections')
@ApiBearerAuth()
@Controller('store-collections')
export class StoreCollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  async initializeStoreCollection(
    @Req() req: any,
    @Body() dto: CreateCollectionDto,
  ) {
    const payload: CreateCollectionDto = {
      ...dto,
      mode: dto.mode ?? 'existing',
      isAvailableInStore: true,
    };
    return this.collectionsService.initializeCollection(req.user.id, payload);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/finalize')
  async finalizeStoreCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: FinalizeCollectionDto,
  ) {
    return this.collectionsService.finalizeCollection(
      collectionId,
      req.user.id,
      dto,
      'store',
    );
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async listPublicStoreCollections(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    return this.collectionsService.listPublicStoreCollections({
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      requesterId: req?.user?.id,
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('user/:userId')
  async getUserStoreCollections(
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
      scope: 'store',
      includeDeleted:
        includeDeleted === 'true' || includeDeleted === '1',
      onlyDeleted: onlyDeleted === 'true' || onlyDeleted === '1',
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async getStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.getCollection(collectionId, req.user?.id, 'store');
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateStoreCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionsService.updateCollection(
      collectionId,
      req.user.id,
      dto,
      'store',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/archive')
  async archiveStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.archiveCollection(collectionId, req.user.id, 'store');
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/unarchive')
  async unarchiveStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.unarchiveCollection(collectionId, req.user.id, 'store');
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.deleteCollection(collectionId, req.user.id, 'store');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/restore')
  async restoreStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.restoreCollection(collectionId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/permanent')
  async permanentlyDeleteStoreCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.permanentlyDeleteCollection(
      collectionId,
      req.user.id,
      'store',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  async duplicateStoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.duplicateCollection(collectionId, req.user.id, 'store');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/add-products')
  async addProductsToCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: AddProductsDto,
  ) {
    return this.collectionsService.addProductsToCollection(
      collectionId,
      req.user.id,
      dto.productIds,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/remove-products')
  async removeProductsFromCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: AddProductsDto,
  ) {
    return this.collectionsService.removeProductsFromCollection(
      collectionId,
      req.user.id,
      dto.productIds,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':collectionId/reorder-products')
  async reorderCollectionProducts(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: ReorderCollectionProductsDto,
  ) {
    return this.collectionsService.reorderCollectionProducts(
      collectionId,
      req.user.id,
      dto.items,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/apply-template')
  async applyTemplate(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: ApplyTemplateDto,
  ) {
    return this.collectionsService.applyTemplateToCollectionProducts(
      collectionId,
      req.user.id,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/products')
  // STORE_COLLECTION_GROUPING:
  // Creates a Product inside a StoreCollection grouping. StoreService remains
  // the owner for product price, inventory, media, SKU, and checkout behavior.
  async createProductInCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: CreateProductDto,
  ) {
    return this.collectionsService.createProductInCollection(
      collectionId,
      req.user.id,
      dto,
    );
  }
}
