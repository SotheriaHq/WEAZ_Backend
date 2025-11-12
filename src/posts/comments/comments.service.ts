import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Comment } from '@prisma/client';
import {
  CreateCommentDto,
  UpdateCommentDto,
  GetCommentsDto,
} from '../dto/comment.dto';
import { PaginatedResult } from '../../upload/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';

import { ReactionType } from '@prisma/client';

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);
  constructor(private prisma: PrismaService) {}

  async create(
    postId: string,
    userId: string,
    dto: CreateCommentDto,
  ): Promise<Comment> {
    this.logger.warn('Deprecated CommentsService.create called; prefer CommentsV2Service for POST target');
    // Check if post exists
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return this.prisma.comment.create({
      data: {
        id: uuidv4(),
        content: dto.content,
        post: {
          connect: { id: postId },
        },
        user: {
          connect: { id: userId },
        },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
    });
  }

  async getComments(
    postId: string,
    { cursor, limit = 20 }: GetCommentsDto,
  ): Promise<PaginatedResult<Comment>> {
    this.logger.warn('Deprecated CommentsService.getComments called; prefer CommentsV2Service for POST target');
    const items = await this.prisma.comment.findMany({
      where: {
        postId,
        ...(cursor && {
          createdAt: {
            lt: new Date(cursor),
          },
        }),
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit + 1,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
    });

    const hasNextPage = items.length > limit;
    const data = hasNextPage ? items.slice(0, -1) : items;
    const endCursor =
      data.length > 0 ? data[data.length - 1].createdAt.toISOString() : null;

    return {
      items: data,
      hasNextPage,
      endCursor,
    };
  }

  async update(
    commentId: string,
    userId: string,
    dto: UpdateCommentDto,
  ): Promise<Comment> {
    this.logger.warn('Deprecated CommentsService.update called; prefer CommentsV2Service for POST target');
    const comment = await this.prisma.comment.findFirst({
      where: {
        id: commentId,
        userId,
      },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found or not owned by user');
    }

    return this.prisma.comment.update({
      where: { id: commentId },
      data: {
        content: dto.content,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
    });
  }

  async delete(commentId: string, userId: string): Promise<void> {
    this.logger.warn('Deprecated CommentsService.delete called; prefer CommentsV2Service for POST target');
    const comment = await this.prisma.comment.findFirst({
      where: {
        id: commentId,
        userId,
      },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found or not owned by user');
    }

    await this.prisma.comment.delete({
      where: { id: commentId },
    });
  }

  // Toggle reaction (LIKE/DISLIKE) on a comment
  async toggleReaction(
    commentId: string,
    userId: string,
    type: ReactionType,
  ): Promise<{
    reacted: boolean;
    type: ReactionType;
    likes: number;
    dislikes: number;
  }> {
    this.logger.warn('Deprecated CommentsService.toggleReaction called; prefer CommentsV2Service for POST target');
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    const existing = await this.prisma.commentReaction
      .findUnique({
        where: { commentId_userId: { commentId, userId } },
      })
      .catch(() => null);

    if (existing) {
      if (existing.type === type) {
        // Remove reaction (toggle off)
        await this.prisma.commentReaction.delete({
          where: { id: existing.id },
        });
      } else {
        // Switch reaction type
        await this.prisma.commentReaction.update({
          where: { id: existing.id },
          data: { type },
        });
      }
    } else {
      // Create reaction
      await this.prisma.commentReaction.create({
        data: { id: uuidv4(), commentId, userId, type },
      });
    }

    // Return counts
    const [likes, dislikes] = await Promise.all([
      this.prisma.commentReaction.count({
        where: { commentId, type: ReactionType.LIKE },
      }),
      this.prisma.commentReaction.count({
        where: { commentId, type: ReactionType.DISLIKE },
      }),
    ]);

    return { reacted: true, type, likes, dislikes };
  }

  // Get users who reacted to a comment (latest N)
  async getReactions(commentId: string, limit = 20) {
    this.logger.warn('Deprecated CommentsService.getReactions called; prefer CommentsV2Service for POST target');
    const [reactions, totalLikes, totalDislikes] = await Promise.all([
      this.prisma.commentReaction.findMany({
        where: { commentId, type: ReactionType.LIKE },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.commentReaction.count({
        where: { commentId, type: ReactionType.LIKE },
      }),
      this.prisma.commentReaction.count({
        where: { commentId, type: ReactionType.DISLIKE },
      }),
    ]);

    return { users: reactions.map((r) => r.user), totalLikes, totalDislikes };
  }
}
