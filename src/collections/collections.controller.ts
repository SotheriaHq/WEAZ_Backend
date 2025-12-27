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
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { UserTypeGuard } from 'src/auth/guard/user-type.guard';
import { UserType, ReactionType, PatchStatus } from '@prisma/client';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { EventsGateway } from 'src/realtime/events.gateway';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@ApiTags('collections')
@ApiBearerAuth()
// @UseGuards(JwtAuthGuard)
// @UseGuards(UserTypeGuard)
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly events: EventsGateway,
  ) {}

  // ============================================
  // STEP 1: Initialize Collection (Get Presigned URLs)
  // ============================================
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
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
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
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
  ) {
    return this.collectionsService.finalizeCollection(
      collectionId,
      req.user.id,
      dto,
    );
  }

  // ============================================
  // STATIC ROUTES (must come before :id dynamic route)
  // ============================================

  @Get()
  @ApiOperation({ summary: 'List collections (paginated, sorted by patches)' })
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

  @Get('categories')
  @ApiOperation({ summary: 'Get active collection categories' })
  @ApiResponse({ status: 200, description: 'List of active categories' })
  async getCategories() {
    return this.collectionsService.listCategories();
  }

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
    @Query('counts') countsPolicy?: string,
    @Req() req?: any,
  ) {
    return this.collectionsService.getMarketFeed({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      tag,
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
  @Get('patches/my')
  @ApiOperation({ summary: 'Get collections patched by current user' })
  @ApiResponse({ status: 200, description: 'List of collections I patched' })
  async getMyPatches(
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getBrandPatches(req.user.id, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get collections for a specific user (brand)' })
  @UseGuards(JwtAuthGuard)
  async getUserCollections(
    @Param('userId') userId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('visibility') visibility?: 'public' | 'private' | 'all',
    @Req() req?: any,
  ) {
    // If the requester is the same as the userId, include drafts; otherwise only published
    const requesterId = req?.user?.id;
    try {
      console.log(
        '[collections:getUserCollections] userId=%s requesterId=%s visibility=%s cursor=%s limit=%s',
        userId,
        requesterId ?? 'anon',
        visibility ?? 'public',
        cursor ?? '-',
        limit ?? '-',
      );
    } catch {}
    return this.collectionsService.getUserCollections(userId, requesterId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
      visibility,
    });
  }

  // ============================================
  // DYNAMIC ROUTE (must come after static routes)
  // ============================================

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get collection by ID' })
  @ApiResponse({ status: 200, description: 'Collection details' })
  async getCollection(@Param('id') id: string, @Req() req: any) {
    // Record view if accessing collection
    const userId = req.user?.id;
    const ipAddress = req.ip || req.connection.remoteAddress;
    try {
      console.log(
        '[collections:getCollection] id=%s requesterId=%s',
        id,
        userId ?? 'anon',
      );
    } catch {}

    // Record view asynchronously (don't wait)
    this.collectionsService.recordView(id, userId, ipAddress).catch((err) => {
      console.warn('Failed to record view:', err);
    });

    return this.collectionsService.getCollection(id, req.user?.id);
  }

  // ============================================
  // INTERACTION OPERATIONS
  // ============================================
  @UseGuards(JwtAuthGuard)
  @Post(':id/reactions/:type')
  @ApiOperation({
    summary: 'Toggle reaction on collection',
    description:
      'Like or dislike a collection. Calling same reaction twice removes it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reaction toggled',
    schema: {
      type: 'object',
      properties: {
        likes: { type: 'number' },
        dislikes: { type: 'number' },
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
    const reactionType = type.toUpperCase() as ReactionType;

    if (!Object.values(ReactionType).includes(reactionType)) {
      throw new BadRequestException(
        'Invalid reaction type. Use LIKE or DISLIKE',
      );
    }

    const result = await this.collectionsService.toggleReaction(
      collectionId,
      req.user.id,
      reactionType,
    );
    // Emit realtime only for LIKE (dislikes optional)
    if (reactionType === 'LIKE') {
      this.events.emitLike(result.liked ? 'like.created' : 'like.removed', {
        contentType: 'COLLECTION',
        contentId: collectionId,
        userId: req.user.id,
        likeCount: result.likes,
      });
    }
    return result;
  }

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
  @Post(':id/patch')
  @ApiOperation({
    summary: 'Patch collection (Brands only)',
    description: `
      Patching is like "reposting" or "amplifying" a collection.
      Only brands can patch collections.
      Higher patch count = higher visibility in feeds.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Collection patched successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        collectionId: { type: 'string' },
        patchingBrandId: { type: 'string' },
        weight: { type: 'number' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async patchCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Body() body: { weight?: number },
  ) {
    return this.collectionsService.patchCollection(
      collectionId,
      req.user.id,
      body?.weight || 1,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id/patch')
  @ApiOperation({
    summary: 'Remove patch (unpatch collection)',
    description: 'Remove your patch from a collection',
  })
  async removePatch(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.removePatch(collectionId, req.user.id);
  }

  @Get(':id/patches')
  @ApiOperation({ summary: 'Get patches for a collection (who patched it)' })
  @ApiResponse({
    status: 200,
    description: 'List of patches with brand details',
  })
  async getCollectionPatches(
    @Param('id') collectionId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.collectionsService.getCollectionPatches(collectionId, {
      cursor,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  // ============================================
  // ANALYTICS ENDPOINT
  // ============================================
  @Get(':id/stats')
  @ApiOperation({ summary: 'Get collection statistics' })
  @ApiResponse({
    status: 200,
    description: 'Collection statistics',
    schema: {
      type: 'object',
      properties: {
        views: { type: 'number' },
        likes: { type: 'number' },
        dislikes: { type: 'number' },
        comments: { type: 'number' },
        patches: { type: 'number' },
        engagement_rate: { type: 'number' },
      },
    },
  })
  async getCollectionStats(@Param('id') collectionId: string, @Req() req: any) {
    const collection = await this.collectionsService.getCollection(
      collectionId,
      req.user?.id,
    );

    const totalInteractions =
      collection._count.reactions +
      collection._count.comments +
      collection._count.patches;

    const engagementRate =
      collection._count.views > 0
        ? (totalInteractions / collection._count.views) * 100
        : 0;

    return {
      views: collection._count.views,
      likes: collection.likesCount,
      dislikes: collection.dislikesCount,
      comments: collection._count.comments,
      patches: collection._count.patches,
      engagement_rate: Math.round(engagementRate * 100) / 100,
    };
  }

  // ============================================
  // DELETE COLLECTION / DELETE ITEM
  // ============================================
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete(':id')
  @ApiOperation({ summary: 'Delete entire collection (owner only)' })
  async deleteCollection(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.deleteCollection(collectionId, req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
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
  @Post('media/:mediaId/reaction/like')
  async toggleMediaLike(@Param('mediaId') mediaId: string, @Req() req: any) {
    const res = await this.collectionsService.toggleMediaLike(
      mediaId,
      req.user.id,
    );
    this.events.emitLike(res.liked ? 'like.created' : 'like.removed', {
      contentType: 'COLLECTION_MEDIA',
      contentId: mediaId,
      userId: req.user.id,
      likeCount: res.likes,
    });
    return res;
  }

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

  @UseGuards(OptionalJwtAuthGuard)
  @Get('media/:mediaId/is-liked')
  async isMediaLiked(@Param('mediaId') mediaId: string, @Req() req: any) {
    return this.collectionsService.isMediaLikedByUser(mediaId, req.user?.id);
  }

  // Is-liked for a collection
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/is-liked')
  async isCollectionLiked(@Param('id') collectionId: string, @Req() req: any) {
    return this.collectionsService.isCollectionLikedByUser(
      collectionId,
      req.user?.id,
    );
  }

  // Likes summary for a collection (collection likes + media likes)
  @Get(':id/likes/summary')
  @ApiOperation({ summary: 'Get likes summary for a collection' })
  async getLikesSummary(@Param('id') collectionId: string) {
    return this.collectionsService.getLikesSummary(collectionId);
  }

  // Categories
  @Get('categories')
  @ApiOperation({ summary: 'List active collection categories' })
  async listCategories() {
    return this.collectionsService.listCategories();
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
  @Get(':id/metrics/access')
  @ApiOperation({ summary: 'Access request metrics for a collection' })
  async getAccessMetrics(
    @Param('id') collectionId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.collectionsService.getAccessMetrics(collectionId, from, to);
  }

  @Get(':id/metrics/views')
  @ApiOperation({ summary: 'Private views metrics for a collection' })
  async getViewsMetrics(
    @Param('id') collectionId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.collectionsService.getPrivateViewsMetrics(
      collectionId,
      from,
      to,
    );
  }

  // ===================== Update collection meta (price/tags/discount) =====================
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch(':id')
  @ApiOperation({ summary: 'Update collection fields (owner only)' })
  async updateCollection(
    @Param('id') collectionId: string,
    @Req() req: any,
    @Body() body: UpdateCollectionDto,
  ) {
    return this.collectionsService.updateCollection(
      collectionId,
      req.user.id,
      body,
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
