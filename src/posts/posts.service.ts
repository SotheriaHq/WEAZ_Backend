import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto, UpdatePostDto, GetPostsDto } from './dto/post.dto';
import { Post, ContentTarget } from '@prisma/client';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { PaginatedResult } from '../upload/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PostsService {
  constructor(private prisma: PrismaService, private readonly analytics?: AnalyticsService) {}

  async create(userId: string, dto: CreatePostDto): Promise<Post> {
    // Verify that all referenced files exist and belong to the user
    if (dto.imageIds?.length) {
      const files = await this.prisma.fileUpload.findMany({
        where: {
          id: { in: dto.imageIds },
          userId,
        },
      });

      if (files.length !== dto.imageIds.length) {
        throw new BadRequestException(
          'One or more image files not found or not owned by user',
        );
      }
    }

    if (dto.videoId) {
      const video = await this.prisma.fileUpload.findFirst({
        where: {
          id: dto.videoId,
          userId,
        },
      });

      if (!video) {
        throw new BadRequestException(
          'Video file not found or not owned by user',
        );
      }
    }

    // Create the post with file relationships
    const postId = uuidv4();
    return this.prisma.post.create({
      data: {
        id: postId,
        content: dto.content,
        imageIds: dto.imageIds || [],
        user: {
          connect: { id: userId },
        },
        ...(dto.imageIds?.length && {
          images: {
            connect: dto.imageIds.map((id) => ({ id })),
          },
        }),
        ...(dto.videoId && {
          video: {
            connect: { id: dto.videoId },
          },
        }),
      },
      include: {
        user: true,
        images: true,
        video: true,
        comments: {
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5, // Get latest 5 comments by default
        },
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });
  }

  async getPosts(
    userId: string,
    { cursor, limit = 20 }: GetPostsDto,
  ): Promise<PaginatedResult<Post>> {
    const items = await this.prisma.post.findMany({
      where: {
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
        user: true,
        images: true,
        video: true,
        comments: {
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5,
        },
        _count: {
          select: {
            likes: true,
            comments: true,
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

  async getPost(id: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: true,
        images: true,
        video: true,
        comments: {
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return post;
  }

  async update(id: string, userId: string, dto: UpdatePostDto): Promise<Post> {
    const post = await this.prisma.post.findFirst({
      where: { id, userId },
    });

    if (!post) {
      throw new NotFoundException('Post not found or not owned by user');
    }

    return this.prisma.post.update({
      where: { id },
      data: {
        content: dto.content,
      },
      include: {
        user: true,
        images: true,
        video: true,
        comments: {
          include: {
            user: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5,
        },
        _count: {
          select: {
            likes: true,
            comments: true,
          },
        },
      },
    });
  }

  async delete(id: string, userId: string): Promise<void> {
    const post = await this.prisma.post.findFirst({
      where: { id, userId },
    });

    if (!post) {
      throw new NotFoundException('Post not found or not owned by user');
    }

    await this.prisma.post.delete({
      where: { id },
    });
  }

  async toggleLike(
    postId: string,
    userId: string,
  ): Promise<{ liked: boolean; likesCount: number }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existingLike = await this.prisma.like.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    if (existingLike) {
      // Unlike
      await this.prisma.like.delete({
        where: {
          postId_userId: {
            postId,
            userId,
          },
        },
      });

      const updatedPost = await this.prisma.post.update({
        where: { id: postId },
        data: {
          likesCount: {
            decrement: 1,
          },
        },
      });

      if (this.analytics) {
        await this.analytics.updateDailyLike(ContentTarget.POST, postId, -1);
      }

      return {
        liked: false,
        likesCount: updatedPost.likesCount,
      };
    } else {
      // Like
      await this.prisma.like.create({
        data: {
          id: uuidv4(),
          post: {
            connect: { id: postId },
          },
          user: {
            connect: { id: userId },
          },
        },
      });

      const updatedPost = await this.prisma.post.update({
        where: { id: postId },
        data: {
          likesCount: {
            increment: 1,
          },
        },
      });

      if (this.analytics) {
        await this.analytics.updateDailyLike(ContentTarget.POST, postId, +1);
      }

      return {
        liked: true,
        likesCount: updatedPost.likesCount,
      };
    }
  }

  async getLikes(postId: string): Promise<{ users: any[]; total: number }> {
    const [likes, count] = await Promise.all([
      this.prisma.like.findMany({
        where: { postId },
        orderBy: { createdAt: 'desc' },
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
        take: 10, // Just get the latest 10 users who liked
      }),
      this.prisma.like.count({
        where: { postId },
      }),
    ]);

    return {
      users: likes.map((like) => like.user),
      total: count,
    };
  }

  async isLiked(postId: string, userId: string): Promise<boolean> {
    const like = await this.prisma.like.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    return !!like;
  }
}
