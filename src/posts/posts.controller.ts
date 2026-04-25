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
import { PostsService } from './posts.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { CreatePostDto, UpdatePostDto, GetPostsDto } from './dto/post.dto';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { UseGuards as UseGuardsDeco } from '@nestjs/common';
import { EventsGateway } from '../realtime/events.gateway';

@ApiTags('posts')
@ApiBearerAuth()
@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly events: EventsGateway,
  ) {}

  @Post()
  create(@Body() createPostDto: CreatePostDto, @Req() req: any) {
    return this.postsService.create(req.user.id, createPostDto);
  }

  @Get()
  getPosts(@Query() query: GetPostsDto, @Req() req: any) {
    return this.postsService.getPosts(req.user.id, query);
  }

  @Get(':id')
  getPost(@Param('id') id: string) {
    return this.postsService.getPost(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updatePostDto: UpdatePostDto,
    @Req() req: any,
  ) {
    return this.postsService.update(id, req.user.id, updatePostDto);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @Req() req: any) {
    return this.postsService.delete(id, req.user.id);
  }

  @UseGuardsDeco(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post(':id/threads')
  async toggleThread(@Param('id') id: string, @Req() req: any) {
    const res = await this.postsService.toggleThread(id, req.user.id);
    this.events.emitThread(res.threaded ? 'thread.created' : 'thread.removed', {
      contentType: 'POST',
      contentId: id,
      userId: req.user.id,
      threadCount: res.threadsCount,
    });
    return res;
  }

  @Get(':id/threads')
  getThreads(@Param('id') id: string) {
    return this.postsService.getThreads(id);
  }

  @Get(':id/is-threaded')
  isThreaded(@Param('id') id: string, @Req() req: any) {
    return this.postsService.isThreaded(id, req.user.id);
  }
}
