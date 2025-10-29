import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { CommentsV2Service } from './commentsv2.service';
import { CreateCommentV2Dto, ListQueryDto } from './dto';

// Versioned routes under /api/v1
@Controller('api/v1')
export class CommentsV2Controller {
  constructor(private readonly service: CommentsV2Service) {}

  // Create comment for POST
  @UseGuards(JwtAuthGuard)
  @Post('posts/:postId/comments')
  createForPost(
    @Param('postId') postId: string,
    @Body() dto: CreateCommentV2Dto,
    @Req() req: any,
  ) {
    return this.service.createForTarget('POST', postId, req.user.id, dto);
  }

  // Create comment for COLLECTION
  @UseGuards(JwtAuthGuard)
  @Post('collections/:collectionId/comments')
  createForCollection(
    @Param('collectionId') collectionId: string,
    @Body() dto: CreateCommentV2Dto,
    @Req() req: any,
  ) {
    return this.service.createForTarget(
      'COLLECTION',
      collectionId,
      req.user.id,
      dto,
    );
  }

  // Create comment for COLLECTION_MEDIA
  @UseGuards(JwtAuthGuard)
  @Post('collections/media/:mediaId/comments')
  createForMedia(
    @Param('mediaId') mediaId: string,
    @Body() dto: CreateCommentV2Dto,
    @Req() req: any,
  ) {
    return this.service.createForTarget(
      'COLLECTION_MEDIA',
      mediaId,
      req.user.id,
      dto,
    );
  }

  // List comments for a target (top-level only; preload latest 2 replies)
  @Get('posts/:postId/comments')
  listForPost(
    @Param('postId') postId: string,
    @Query() q: ListQueryDto,
    @Req() req: any,
  ) {
    return this.service.listForTarget('POST', postId, req.user?.id, q);
  }

  @Get('collections/:collectionId/comments')
  listForCollection(
    @Param('collectionId') id: string,
    @Query() q: ListQueryDto,
    @Req() req: any,
  ) {
    return this.service.listForTarget('COLLECTION', id, req.user?.id, q);
  }

  @Get('collections/media/:mediaId/comments')
  listForMedia(
    @Param('mediaId') id: string,
    @Query() q: ListQueryDto,
    @Req() req: any,
  ) {
    return this.service.listForTarget('COLLECTION_MEDIA', id, req.user?.id, q);
  }

  // Replies
  @Get('comments/:id/replies')
  getReplies(
    @Param('id') id: string,
    @Query() q: ListQueryDto,
    @Req() req: any,
  ) {
    return this.service.getReplies(id, req.user?.id, q);
  }

  // Like toggle
  @UseGuards(JwtAuthGuard)
  @Post('comments/:id/like')
  toggleLike(@Param('id') id: string, @Req() req: any) {
    const clientEventId =
      typeof req.headers['x-client-event-id'] === 'string'
        ? req.headers['x-client-event-id']
        : undefined;
    return this.service.toggleLike(id, req.user.id, clientEventId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('comments/:id/is-liked')
  isLiked(@Param('id') id: string, @Req() req: any) {
    return this.service.isLiked(id, req.user.id);
  }

  // Delete (soft)
  @UseGuards(JwtAuthGuard)
  @Delete('comments/:id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.service.softDelete(id, req.user.id);
  }

  // Stats
  @Get('comments/:id/stats')
  stats(@Param('id') id: string) {
    return this.service.getStats(id);
  }
}
