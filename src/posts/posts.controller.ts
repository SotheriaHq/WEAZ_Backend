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

@ApiTags('posts')
@ApiBearerAuth()
@Controller('posts')
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

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

  @Post(':id/likes')
  toggleLike(@Param('id') id: string, @Req() req: any) {
    return this.postsService.toggleLike(id, req.user.id);
  }

  @Get(':id/likes')
  getLikes(@Param('id') id: string) {
    return this.postsService.getLikes(id);
  }

  @Get(':id/is-liked')
  isLiked(@Param('id') id: string, @Req() req: any) {
    return this.postsService.isLiked(id, req.user.id);
  }
}
