import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Req,
} from '@nestjs/common';
import { CommentsService } from './comments.service';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import {
  CreateCommentDto,
  UpdateCommentDto,
  GetCommentsDto,
} from '../dto/comment.dto';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

@ApiTags('comments')
@ApiBearerAuth()
@Controller('posts/:postId/comments')
@UseGuards(JwtAuthGuard)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a comment for a post' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  create(
    @Param('postId') postId: string,
    @Body() createCommentDto: CreateCommentDto,
    @Req() req: any,
  ) {
    return this.commentsService.create(postId, req.user.id, createCommentDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get comments for a post' })
  @ApiResponse({ status: 200, description: 'Comments list' })
  getComments(@Param('postId') postId: string, @Query() query: GetCommentsDto) {
    return this.commentsService.getComments(postId, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a comment' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  update(
    @Param('id') id: string,
    @Body() updateCommentDto: UpdateCommentDto,
    @Req() req: any,
  ) {
    return this.commentsService.update(id, req.user.id, updateCommentDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a comment' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  delete(@Param('id') id: string, @Req() req: any) {
    return this.commentsService.delete(id, req.user.id);
  }

  // Toggle thread/dislike on a comment
  @Post(':id/reactions/:type')
  @ApiOperation({ summary: 'Toggle thread/dislike on a comment' })
  @ApiResponse({ status: 200, description: 'Reaction toggled' })
  toggleReaction(
    @Param('id') id: string,
    @Param('type') type: string,
    @Req() req: any,
  ) {
    const reactionType = type.toUpperCase() as any;
    return this.commentsService.toggleReaction(id, req.user.id, reactionType);
  }

  // Thread alias for explicit thread action
  @Post(':id/reactions/thread')
  @ApiOperation({ summary: 'Toggle thread on a comment' })
  @ApiResponse({ status: 200, description: 'Reaction toggled' })
  toggleThread(@Param('id') id: string, @Req() req: any) {
    return this.commentsService.toggleReaction(
      id,
      req.user.id,
      'THREAD' as any,
    );
  }

  // Get users who threaded a comment
  @Get(':id/reactions')
  @ApiOperation({ summary: 'Get reactions for a comment' })
  @ApiResponse({ status: 200, description: 'Reactions list' })
  getReactions(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.commentsService.getReactions(id, limit ? parseInt(limit) : 20);
  }
}
