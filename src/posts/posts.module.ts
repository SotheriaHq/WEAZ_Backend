import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { CommentsController } from './comments/comments.controller';
import { CommentsService } from './comments/comments.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [PostsController, CommentsController],
  providers: [PostsService, CommentsService, PrismaService],
  exports: [PostsService, CommentsService],
})
export class PostsModule {}
