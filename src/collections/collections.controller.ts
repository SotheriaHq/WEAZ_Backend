import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  Delete,
  Patch,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import {
  CollectionsService,
  CreateCollectionDto,
  FinalizeCollectionDto,
} from './collections.service';
import { CollectionSchedulerService } from './collection-scheduler.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { UserType, ReactionType, PatchStatus } from '@prisma/client';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { EventsGateway } from 'src/realtime/events.gateway';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import {
  AddProductsDto,
  ApplyTemplateDto,
  RemoveProductsDto,
  ReorderCollectionProductsDto,
} from './dto/collection-products.dto';
import { CreateProductDto } from 'src/store/dto/create-product.dto';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import { collectionBulkUploadMulterOptions } from 'src/upload/upload-policy';

@ApiTags('collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly schedulerService: CollectionSchedulerService,
    private readonly events: EventsGateway,
  ) {}

  // ============================================
  // STEP 1: Initialize Collection (Get Presigned URLs)
  // ============================================
  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // Existing web/mobile clients still use collection-backed paths for design
  // creation. These paths must remain until clients migrate to explicit
  // DesignApi and /designs endpoints.
  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  @ApiOperation({
    summary: 'Initialize collection and get presigned upload URLs',
    description: `
      Step 1 of collection creation:
      - Validates files specifications
      - Creates draft collection
      - Returns presigned URLs for direct S3 upload
      
      Frontend should:
      1. Call this endpoint with file specs
      2. Upload files to S3 using returned URLs
      3. Call /finalize with upload confirmations
    `,
  })
  @ApiResponse({
    status: 201,
    description: 'Collection initialized with upload URLs',
    schema: {
      type: 'object',
      properties: {
        collectionId: { type: 'string', format: 'uuid' },
        uploads: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fileId: { type: 'string' },
              orderIndex: { type: 'number' },
              expectedKey: { type: 'string' },
              uploadUrl: { type: 'string' },
              uploadFields: { type: 'object' },
              expiresIn: { type: 'number' },
            },
          },
        },
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiBody({
    type: CreateCollectionDto,
    examples: {
      'Single Image': {
        value: {
          title: 'My Collection',
          description: 'A beautiful collection',
          files: [
            {
              name: 'photo.jpg',
              type: 'image/jpeg',
              size: 1024000,
            },
          ],
        },
      },
      'Multiple Mixed Media': {
        value: {
          title: 'Brand Showcase',
          description: 'Our latest products',
          files: [
            {
              name: 'hero-image.jpg',
              type: 'image/jpeg',
              size: 2048000,
              fileType: 'POST_IMAGE',
            },
            {
              name: 'demo-video.mp4',
              type: 'video/mp4',
              size: 15728640,
              fileType: 'POST_VIDEO',
            },
          ],
        },
      },
    },
  })
  async initializeCollection(
    @Req() req: any,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionsService.initializeCollection(req.user.id, dto);
  }

  // ============================================
  // STEP 2: Finalize Collection (Confirm Uploads)
  // ============================================
  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // Existing web/mobile clients still use collection-backed paths for design
  // publishing. Do not remove this endpoint until compatibility clients move.
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':collectionId/finalize')
  @ApiOperation({
    summary: 'Finalize collection after S3 uploads complete',
    description: `
      Step 2 of collection creation:
      - Verifies all files uploaded successfully to S3
      - Creates FileUpload records in database
      - Publishes collection (makes it visible)
      
      Call this after uploading all files to S3 using URLs from /initialize
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Collection finalized and published',
  })
  @ApiBody({
    type: FinalizeCollectionDto,
    examples: {
      'Upload Confirmations': {
        value: {
          completions: [
            {
              fileId: '123e4567-e89b-12d3-a456-426614174000',
              s3Key: 'POST_IMAGE/user123/1234567890-file1.jpg',
              actualSize: 1024000,
              actualMimeType: 'image/jpeg',
            },
            {
              fileId: '123e4567-e89b-12d3-a456-426614174001',
              s3Key: 'POST_VIDEO/user123/1234567890-file2.mp4',
              actualSize: 15728640,
              actualMimeType: 'video/mp4',
            },
          ],
        },
      },
    },
  })
  async finalizeCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() dto: FinalizeCollectionDto,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.finalizeCollection(
      collectionId,
      req.user.id,
      dto,
      scope,
    );
  }

  // ============================================
  // Store Collection Product Membership
  // ============================================

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
    @Body() dto: RemoveProductsDto,
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

  // ============================================
  // Archive / Unarchive
  // ============================================

  @UseGuards(JwtAuthGuard)
  @Patch(':collectionId/archive')
  async archiveCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.archiveCollection(
      collectionId,
      req.user.id,
      scope,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':collectionId/unarchive')
  async unarchiveCollection(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.unarchiveCollection(
      collectionId,
      req.user.id,
      scope,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':collectionId/republish-request')
  async requestCollectionRepublish(
    @Param('collectionId') collectionId: string,
    @Req() req: any,
    @Body() body: { reason?: string },
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.requestCollectionRepublishApproval(
      collectionId,
      req.user.id,
      body?.reason,
      scope,
    );
  }

  // ============================================
  // STATIC ROUTES (must come before :id dynamic route)
  // ============================================

  @IsPublic()
  @Get()
  @ApiOperation({ summary: 'List collections (paginated, sorted by collabs)' })
  @ApiResponse({ status: 200, description: 'Paginated collections list' })
  async listCollections(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    return this.collectionsService.listCollections({
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      requesterId: req?.user?.id,
    });
  }

  @IsPublic()
  @Get('categories')
  @ApiOperation({ summary: 'Get active collection categories' })
  @ApiResponse({ status: 200, description: 'List of active categories' })
  async getCategories() {
    return this.collectionsService.listCategories();
  }

  @IsPublic()
  @Get('category-types')
  @ApiOperation({
    summary: 'Get active sub-categories (optionally filtered by categoryId)',
  })
  @ApiResponse({ status: 200, description: 'List of active sub-categories' })
  async getCategoryTypes(@Query('categoryId') categoryId?: string) {
    return this.collectionsService.listCategoryTypes(categoryId);
  }

  @IsPublic()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('market')
  @ApiOperation({
    summary: 'Get market feed of individual collection uploads',
    description:
      'Returns individual collection media entries for the market discovery feed.',
  })
  async getMarketFeed(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('tag') tag?: string,
    @Query('category') category?: string,
    @Query('counts') countsPolicy?: string,
    @Query('feedMode') feedMode?: string,
    @Query('query') query?: string,
    @Query('anchorDesignId') anchorDesignId?: string,
    @Req() req?: any,
  ) {
    // SEARCH-CORE-4: search-pinned Runway feed. Default behaviour is fully
    // preserved when feedMode is missing or 'default'.
    if (feedMode === 'searchPinned') {
      return this.collectionsService.getRunwayPinnedFeed({
        query,
        anchorDesignId,
        cursor,
        limit: limit ? parseInt(limit, 10) : undefined,
        requesterId: req?.user?.id,
      });
    }

    return this.collectionsService.getMarketFeed({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      tag,
      category,
      countsPolicy: countsPolicy === 'combined' ? 'combined' : undefined,
      requesterId: req?.user?.id, // Pass userId if authenticated
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/drafts')
  @ApiOperation({ summary: 'Get my draft collections (PHASE 6)' })
  @ApiResponse({
    status: 200,
    description: 'List of draft collections for current user',
  })
  async getMyDrafts(@Req() req: any) {
    return this.collectionsService.getMyDraftCollections(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my/draft-stats')
  @ApiOperation({ summary: 'Get draft expiry statistics for dashboard' })
  @ApiResponse({
    status: 200,
    description: 'Draft expiry statistics',
    schema: {
      type: 'object',
      properties: {
        totalDrafts: { type: 'number' },
        expiringIn7Days: { type: 'number' },
        expiringIn3Days: { type: 'number' },
        expiringToday: { type: 'number' },
        oldestDraftAge: { type: 'number' },
        draftTtlDays: { type: 'number' },
        warningThresholdDays: { type: 'number' },
      },
    },
  })
  async getMyDraftStats(@Req() req: any) {
    return this.schedulerService.getDraftStats(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('collabs/my')
  @ApiOperation({ summary: 'Get collections I collabed with' })
  @ApiResponse({
    status: 200,
    description: 'List of collections I collabed with',
  })
  async getMyCollabs(
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getBrandCollectionCollabs(req.user.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @IsPublic()
  @Get('user/:userId')
  @ApiOperation({ summary: 'Get collections for a specific user (brand)' })
  @UseGuards(OptionalJwtAuthGuard)
  async getUserCollections(
    @Param('userId') userId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('visibility') visibility?: 'public' | 'private' | 'all',
    @Query('scope') scope?: 'design' | 'store' | 'all',
    @Query('includeDeleted') includeDeleted?: string,
    @Query('onlyDeleted') onlyDeleted?: string,
    @Query('status') status?: string,
    @Req() req?: any,
  ) {
    // If the requester is the same as the userId, include drafts; otherwise only published
    const requesterId = req?.user?.id;
    try {
      console.log(
        '[collections:getUserCollections] userId=%s requesterId=%s visibility=%s cursor=%s limit=%s status=%s',
        userId,
        requesterId ?? 'anon',
        visibility ?? 'public',
        cursor ?? '-',
        limit ?? '-',
        status ?? '-',
      );
    } catch {}
    return this.collectionsService.getUserCollections(userId, requesterId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      visibility,
      scope,
      includeDeleted: includeDeleted === 'true' || includeDeleted === '1',
      onlyDeleted: onlyDeleted === 'true' || onlyDeleted === '1',
      status: status as any,
    });
  }

  // ============================================
  // DYNAMIC ROUTE (must come after static routes)
  // ============================================

  @IsPublic()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get collection by ID' })
  @ApiResponse({ status: 200, description: 'Collection details' })
  async getCollection(
    @Param('id') id: string,
    @Query('scope') scope: 'design' | 'store' | 'all' = 'all',
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    try {
      console.log(
        '[collections:getCollection] id=%s requesterId=%s',
        id,
        userId ?? 'anon',
      );
    } catch {}

    const collection = await this.collectionsService.getCollection(
      id,
      req.user?.id,
      scope,
    );

    // Record view asynchronously only after collection is confirmed readable.
    this.collectionsService
      .recordView(id, userId, ipAddress)
      .catch((err: any) => {
        const status = err?.status ?? err?.response?.statusCode;
        if (status === 404 || status === 410) return;
        console.warn('Failed to record view:', err);
      });

    return collection;
  }

  // ============================================
  // INTERACTION OPERATIONS
  // ============================================
  @UseGuards(JwtAuthGuard)
  @Post(':id/reactions/:type')
  @ApiOperation({
    summary: 'Toggle reaction on collection',
    description:
      'Thread or dislike a collection. Calling same reaction twice removes it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reaction toggled',
    schema: {
      type: 'object',
      properties: {
        threads: { type: 'number' },
        dislikes: { type: 'number' },
        threaded: { type: 'boolean' },
      },
    },
  })
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async toggleReaction(
    @Param('id') collectionId: string,
    @Param('type') type: string,
    @Req() req: any,
  ) {
    const normalizedType = type.toUpperCase();
    const reactionType = normalizedType as ReactionType;

    if (!Object.values(ReactionType).includes(reactionType)) {
      throw new BadRequestException(
        'Invalid reaction type. Use THREAD or DISLIKE',
      );
    }

    const result = await this.collectionsService.toggleReaction(
      collectionId,
      req.user.id,
      reactionType,
    );
    // Emit realtime only for THREAD (dislikes optional)
    if (reactionType === ReactionType.THREAD) {
      this.events.emitThread(
        result.threaded ? 'thread.created' : 'thread.removed',
        {
          contentType: 'COLLECTION',
          contentId: collectionId,
          userId: req.user.id,
          threadCount: result.threads,
        },
      );
    }
    return result;
  }

  @IsPublic()
  @Get(':id/reactions')
  @ApiOperation({ summary: 'Get collection reactions with user details' })
  @ApiResponse({ status: 200, description: 'Reactions list' })
  async getReactions(
    @Param('id') collectionId: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getReactions(
      collectionId,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/collab')
  @ApiOperation({
    summary: 'Create collection collab (Brands only)',
    description: `
      CollectionCollab is a brand amplification/collaboration on a collection.
      Only brands can create collabs on collections.
      Higher collab count = higher visibility in feeds.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Collection collab created successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        collectionId: { type: 'string' },
        collabBrandId: { type: 'string' },
        weight: { type: 'number' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async createCollectionCollab(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Body() body: { weight?: number },
  ) {
    return this.collectionsService.createCollectionCollab(
      collectionId,
      req.user.id,
      body?.weight || 1,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id/collab')
  @ApiOperation({
    summary: 'Remove collection collab',
    description: 'Remove your collab from a collection',
  })
  async removeCollectionCollab(
    @Param('id') collectionId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.removeCollectionCollab(
      collectionId,
      req.user.id,
    );
  }

  @IsPublic()
  @Get(':id/collabs')
  @ApiOperation({ summary: 'Get collabs for a collection (who collabed)' })
  @ApiResponse({
    status: 200,
    description: 'List of collabs with brand details',
  })
  async getCollectionCollabs(
    @Param('id') collectionId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getCollectionCollabs(collectionId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  // ============================================
  // ANALYTICS ENDPOINT
  // ============================================
  @IsPublic()
  @Get(':id/stats')
  @ApiOperation({ summary: 'Get collection statistics' })
  @ApiResponse({
    status: 200,
    description: 'Collection statistics',
    schema: {
      type: 'object',
      properties: {
        views: { type: 'number' },
        threads: { type: 'number' },
        dislikes: { type: 'number' },
        comments: { type: 'number' },
        collabs: { type: 'number' },
        engagement_rate: { type: 'number' },
      },
    },
  })
  async getCollectionStats(@Param('id') collectionId: string, @Req() req: any) {
    const collection = await this.collectionsService.getCollection(
      collectionId,
      req.user?.id,
    );

    const reactionsCount = collection._count?.reactions ?? 0;
    const commentsCount = collection._count?.comments ?? 0;
    const collabsCount =
      collection.collectionCollabCount ??
      collection._count?.collectionCollabs ??
      0;
    const viewsCount = collection._count?.views ?? 0;
    const totalInteractions = reactionsCount + commentsCount + collabsCount;

    const engagementRate =
      viewsCount > 0 ? (totalInteractions / viewsCount) * 100 : 0;

    return {
      views: viewsCount,
      threads: collection.threadsCount ?? 0,
      dislikes: collection.dislikesCount,
      comments: commentsCount,
      collabs: collabsCount,
      engagement_rate: Math.round(engagementRate * 100) / 100,
    };
  }

  // ============================================
  // DELETE COLLECTION / DELETE ITEM
  // ============================================
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete entire collection (owner only)' })
  async deleteCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.deleteCollection(
      collectionId,
      req.user.id,
      scope,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  @ApiOperation({ summary: 'Duplicate a collection (owner only)' })
  async duplicateCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.duplicateCollection(
      collectionId,
      req.user.id,
      scope,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':collectionId/items/:itemId')
  @ApiOperation({
    summary: 'Delete a single item from a collection (owner only)',
  })
  async deleteCollectionItem(
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.deleteCollectionItem(
      collectionId,
      itemId,
      req.user.id,
    );
  }
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('media/:mediaId/reaction/thread')
  async toggleMediaThread(@Param('mediaId') mediaId: string, @Req() req: any) {
    const res = await this.collectionsService.toggleMediaThread(
      mediaId,
      req.user.id,
    );
    this.events.emitThread(res.threaded ? 'thread.created' : 'thread.removed', {
      contentType: 'COLLECTION_MEDIA',
      contentId: mediaId,
      userId: req.user.id,
      threadCount: res.threads,
    });
    return res;
  }

  @IsPublic()
  @Get('media/:mediaId/reactions')
  async getMediaReactions(
    @Param('mediaId') mediaId: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getMediaReactions(
      mediaId,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @IsPublic()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('media/:mediaId/is-threaded')
  async isMediaThreaded(@Param('mediaId') mediaId: string, @Req() req: any) {
    return this.collectionsService.isMediaThreadedByUser(mediaId, req.user?.id);
  }

  @IsPublic()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/is-threaded')
  async isCollectionThreaded(
    @Param('id') collectionId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.isCollectionThreadedByUser(
      collectionId,
      req.user?.id,
    );
  }

  @IsPublic()
  // Threads summary for a collection (collection threads + media threads)
  @Get(':id/threads/summary')
  @ApiOperation({ summary: 'Get threads summary for a collection' })
  async getThreadsSummary(@Param('id') collectionId: string) {
    return this.collectionsService.getThreadsSummary(collectionId);
  }

  // ===================== Access Management =====================
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/access-requests')
  @ApiOperation({ summary: 'Request access to a private collection' })
  async requestAccess(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.requestAccess(collectionId, req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get(':id/access-requests')
  @ApiOperation({ summary: 'List pending access requests (owner only)' })
  async listAccessRequests(
    @Param('id') collectionId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Req() req?: any,
  ) {
    return this.collectionsService.listAccessRequests(
      collectionId,
      req.user.id,
      limit ? parseInt(limit, 10) : 20,
      cursor,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get(':id/access')
  @ApiOperation({ summary: 'List approved viewers (owner only)' })
  async listApproved(
    @Param('id') collectionId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Req() req?: any,
  ) {
    return this.collectionsService.listApprovedViewers(
      collectionId,
      req.user.id,
      limit ? parseInt(limit, 10) : 20,
      cursor,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/access/grant')
  @ApiOperation({ summary: 'Approve access for multiple users (owner only)' })
  async approveBulk(
    @Param('id') collectionId: string,
    @Body() body: { userIds: string[] },
    @Req() req: any,
  ) {
    return this.collectionsService.approveAccessBulk(
      collectionId,
      req.user.id,
      Array.isArray(body?.userIds) ? body.userIds : [],
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id/access/:userId')
  @ApiOperation({ summary: 'Update access state (APPROVED/REVOKED)' })
  async updateAccess(
    @Param('id') collectionId: string,
    @Param('userId') userId: string,
    @Body() body: { state: 'APPROVED' | 'REVOKED' },
    @Req() req: any,
  ) {
    const state = body?.state === 'APPROVED' ? 'APPROVED' : 'REVOKED';
    return this.collectionsService.updateAccessState(
      collectionId,
      req.user.id,
      userId,
      state,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id/access/:userId/reject')
  @ApiOperation({ summary: 'Reject a pending access request (owner only)' })
  async rejectAccess(
    @Param('id') collectionId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.rejectAccess(
      collectionId,
      req.user.id,
      userId,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id/access/:userId')
  @ApiOperation({ summary: 'Revoke access (owner only)' })
  async revokeAccess(
    @Param('id') collectionId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.updateAccessState(
      collectionId,
      req.user.id,
      userId,
      'REVOKED',
    );
  }

  // Invite links (feature-flagged)
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/access/invite-link')
  @ApiOperation({ summary: 'Create invite link token (owner only)' })
  async createInvite(
    @Param('id') collectionId: string,
    @Body() body: { ttlSeconds?: number },
    @Req() req: any,
  ) {
    return this.collectionsService.createInviteLink(
      collectionId,
      req.user.id,
      body?.ttlSeconds ?? 86400,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('access/invite/accept')
  @ApiOperation({ summary: 'Accept invite to a collection' })
  async acceptInvite(@Body() body: { token: string }, @Req() req: any) {
    return this.collectionsService.acceptInvite(body?.token, req.user.id);
  }

  // Metrics
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get(':id/metrics/access')
  @ApiOperation({ summary: 'Access request metrics for a collection' })
  async getAccessMetrics(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.collectionsService.getAccessMetrics(
      collectionId,
      req.user.id,
      from,
      to,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get(':id/metrics/views')
  @ApiOperation({ summary: 'Private views metrics for a collection' })
  async getViewsMetrics(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.collectionsService.getPrivateViewsMetrics(
      collectionId,
      req.user.id,
      from,
      to,
    );
  }

  // ===================== Update collection meta (price/tags/discount) =====================
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiOperation({ summary: 'Update collection fields (owner only)' })
  async updateCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Body() body: UpdateCollectionDto,
    @Query('scope') scope?: 'design' | 'store' | 'all',
  ) {
    return this.collectionsService.updateCollection(
      collectionId,
      req.user.id,
      body,
      scope,
    );
  }

  @IsPublic()
  // ===================== Cart Preview =====================
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/cart-preview')
  @ApiOperation({
    summary: 'Preview collection products for add-to-cart',
    description:
      'Returns available and unavailable products with variant-level stock info',
  })
  async getCollectionCartPreview(
    @Param('id') collectionId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.getCollectionCartPreview(
      collectionId,
      req?.user?.id,
    );
  }

  // ===================== Bulk Upload (Scaffold) =====================
  @UseGuards(JwtAuthGuard)
  @Post(':id/bulk-upload')
  @UseInterceptors(FileInterceptor('file', collectionBulkUploadMulterOptions()))
  @ApiOperation({
    summary: 'Initiate bulk product upload',
    description:
      'Creates a bulk upload job for CSV/images. Returns upload URL and job ID.',
  })
  async initiateBulkUpload(
    @Param('id') collectionId: string,
    @Body() body: { mode?: 'csv' | 'images' | 'mixed' },
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.collectionsService.initiateBulkUpload(
      collectionId,
      req.user.id,
      body?.mode || 'csv',
      file,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('bulk-upload/:jobId')
  @ApiOperation({ summary: 'Get bulk upload job status' })
  async getBulkUploadStatus(@Param('jobId') jobId: string, @Req() req: any) {
    return this.collectionsService.getBulkUploadStatus(jobId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('bulk-upload/:jobId/retry')
  @ApiOperation({ summary: 'Retry failed bulk upload rows' })
  async retryBulkUploadRows(
    @Param('jobId') jobId: string,
    @Body() body: { rowIndices?: number[]; rows?: number[] },
    @Req() req: any,
  ) {
    const rowIndices = Array.isArray(body?.rowIndices)
      ? body.rowIndices
      : Array.isArray(body?.rows)
        ? body.rows
        : [];
    return this.collectionsService.retryBulkUploadRows(
      jobId,
      req.user.id,
      rowIndices,
    );
  }

  // ===================== Custom Fit Inquiry (Scaffold) =====================
  @UseGuards(JwtAuthGuard)
  @Post(':id/custom-fit-inquiry')
  @ApiOperation({
    summary: 'Submit custom fit inquiry for collection',
    description: 'Sends inquiry to brand when all products are out of stock',
  })
  async submitCustomFitInquiry(
    @Param('id') collectionId: string,
    @Body()
    body: {
      productId?: string;
      message: string;
      measurements?: string;
      preferredSize?: string;
    },
    @Req() req: any,
  ) {
    return this.collectionsService.submitCustomFitInquiry(
      collectionId,
      req.user.id,
      body,
    );
  }

  // ===================== Draft Conflict Detection =====================
  @UseGuards(JwtAuthGuard)
  @Post(':id/draft-session')
  @ApiOperation({
    summary: 'Start draft editing session',
    description: 'Checks for conflicts and returns session info',
  })
  async startDraftSession(
    @Param('id') draftId: string,
    @Body()
    body: { deviceName?: string; forceNew?: boolean; existingToken?: string },
    @Req() req: any,
  ) {
    return this.collectionsService.checkDraftConflict(
      draftId,
      req.user.id,
      body?.deviceName,
      body?.forceNew,
      body?.existingToken,
    );
  }

  // ===================== Restore Deleted Collection =====================
  @UseGuards(JwtAuthGuard)
  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a soft-deleted collection',
    description: 'Restores a collection within the 30-day recovery window.',
  })
  async restoreCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.restoreCollection(collectionId, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/permanent')
  @ApiOperation({
    summary: 'Permanently delete a soft-deleted collection',
    description: 'Removes collection data and media immediately.',
  })
  async permanentlyDeleteCollection(
    @Param('id') collectionId: string,
    @Query('scope') scope?: 'design' | 'store' | 'all',
    @Req() req?: any,
  ) {
    return this.collectionsService.permanentlyDeleteCollection(
      collectionId,
      req.user.id,
      scope,
    );
  }

  // ===================== Delete Collection Media =====================
  @UseGuards(JwtAuthGuard)
  @Delete(':id/media/:mediaId')
  @ApiOperation({
    summary: 'Delete collection media',
    description: 'Deletes media and reassigns cover if needed',
  })
  async deleteCollectionMedia(
    @Param('id') collectionId: string,
    @Param('mediaId') mediaId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.deleteCollectionMedia(
      collectionId,
      mediaId,
      req.user.id,
    );
  }

  // ===================== Contributions =====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post(':id/contribute')
  @ApiOperation({ summary: 'Request to contribute to a collection' })
  async requestContribution(
    @Param('id') collectionId: string,
    @Body() body: { message?: string },
    @Req() req: any,
  ) {
    return this.collectionsService.requestContribution(
      req.user.id,
      collectionId,
      body?.message,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get(':id/contributions')
  @ApiOperation({ summary: 'List contribution requests (owner only)' })
  async listContributionRequests(
    @Param('id') collectionId: string,
    @Req() req: any,
  ) {
    return this.collectionsService.getContributionRequests(
      collectionId,
      req.user.id,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('contributions/:requestId/respond')
  @ApiOperation({ summary: 'Respond to contribution request' })
  async respondToContribution(
    @Param('requestId') requestId: string,
    @Body() body: { status: 'ACCEPTED' | 'REJECTED' },
    @Req() req: any,
  ) {
    const status =
      body.status === 'ACCEPTED' ? PatchStatus.ACCEPTED : PatchStatus.REJECTED;
    return this.collectionsService.respondToContribution(
      req.user.id,
      requestId,
      status,
    );
  }
}
