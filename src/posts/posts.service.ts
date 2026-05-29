import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePostDto, UpdatePostDto, GetPostsDto } from './dto/post.dto';
import {
  Post,
  ContentTarget,
  NotificationType,
  UserType,
  PatchStatus,
  PatchMode,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AnalyticsService } from 'src/analytics/analytics.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import { PaginatedResult } from '../upload/dto/pagination.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  canonicalUserProfileSelect,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
import {
  canonicalBrandProfileSelect,
  resolveRequiredBrandField,
} from 'src/common/brand-profile-source.helper';

const postUserDisplaySelect = {
  id: true,
  username: true,
  email: true,
  role: true,
  type: true,
  status: true,
  isEmailVerified: true,
  createdAt: true,
  updatedAt: true,
  userProfile: { select: canonicalUserProfileSelect },
  brand: { select: canonicalBrandProfileSelect },
} as const;

@Injectable()
export class PostsService {
  constructor(
    private prisma: PrismaService,
    private readonly analytics?: AnalyticsService,
    private readonly notifications?: NotificationsService,
    private readonly notificationsQueue?: NotificationsQueueService,
  ) {}

  private mapPost<
    T extends Post & { _count?: { threads?: number; comments?: number } },
  >(post: T) {
    const { _count, ...rest } = post as any;
    const threadsCount =
      typeof post.threadsCount === 'number'
        ? post.threadsCount
        : (_count?.threads ?? 0);
    const commentsCount =
      typeof post.commentsCount === 'number'
        ? post.commentsCount
        : (_count?.comments ?? 0);
    return {
      ...rest,
      user: rest.user ? this.mapUserDisplay(rest.user) : rest.user,
      comments: Array.isArray(rest.comments)
        ? rest.comments.map((comment: any) => ({
            ...comment,
            user: comment.user
              ? this.mapUserDisplay(comment.user)
              : comment.user,
          }))
        : rest.comments,
      threadsCount,
      commentsCount,
    };
  }

  private mapUserDisplay(user: any) {
    const { userProfile, brand, ...rest } = user;
    const profileImage = resolveProfileImage({ userProfile });

    return {
      ...rest,
      firstName: resolveRequiredProfileField({ userProfile }, 'firstName'),
      lastName: resolveRequiredProfileField({ userProfile }, 'lastName'),
      profileImage: profileImage.url,
      profileImageId: profileImage.fileId,
      profileImageFile: profileImage.file,
      brandFullName:
        resolveRequiredBrandField({ brand }, 'brandFullName') || null,
    };
  }

  async create(userId: string, dto: CreatePostDto): Promise<any> {
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
    const created = await this.prisma.post.create({
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
        user: { select: postUserDisplaySelect },
        images: true,
        video: true,
        comments: {
          include: {
            user: { select: postUserDisplaySelect },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5, // Get latest 5 comments by default
        },
        _count: { select: { threads: true, comments: true } },
      },
    });
    return this.mapPost(created);
  }

  async getPosts(
    userId: string,
    { cursor, limit = 20 }: GetPostsDto,
  ): Promise<PaginatedResult<any>> {
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
        user: { select: postUserDisplaySelect },
        images: true,
        video: true,
        comments: {
          include: {
            user: { select: postUserDisplaySelect },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5,
        },
        _count: { select: { threads: true, comments: true } },
      },
    });

    const hasNextPage = items.length > limit;
    const data = hasNextPage ? items.slice(0, -1) : items;
    const endCursor =
      data.length > 0 ? data[data.length - 1].createdAt.toISOString() : null;

    return {
      items: data.map((post) => this.mapPost(post)),
      hasNextPage,
      endCursor,
    };
  }

  async getPost(id: string): Promise<any> {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        user: { select: postUserDisplaySelect },
        images: true,
        video: true,
        comments: {
          include: {
            user: { select: postUserDisplaySelect },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        _count: { select: { threads: true, comments: true } },
      },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return this.mapPost(post);
  }

  async update(id: string, userId: string, dto: UpdatePostDto): Promise<any> {
    const post = await this.prisma.post.findFirst({
      where: { id, userId },
    });

    if (!post) {
      throw new NotFoundException('Post not found or not owned by user');
    }

    const updated = await this.prisma.post.update({
      where: { id },
      data: {
        content: dto.content,
      },
      include: {
        user: { select: postUserDisplaySelect },
        images: true,
        video: true,
        comments: {
          include: {
            user: { select: postUserDisplaySelect },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 5,
        },
        _count: { select: { threads: true, comments: true } },
      },
    });
    return this.mapPost(updated);
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

  async toggleThread(
    postId: string,
    userId: string,
  ): Promise<{ threaded: boolean; threadsCount: number }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        userId: true,
        user: {
          select: {
            type: true,
            username: true,
            brand: { select: canonicalBrandProfileSelect },
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existingThread = await this.prisma.thread.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    if (existingThread) {
      // Unthread
      await this.prisma.thread.delete({
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
          threadsCount: {
            decrement: 1,
          },
        },
      });

      if (this.analytics) {
        await this.analytics.updateDailyThread(ContentTarget.POST, postId, -1);
      }

      return {
        threaded: false,
        threadsCount: updatedPost.threadsCount,
      };
    } else {
      // Thread
      await this.prisma.thread.create({
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
          threadsCount: {
            increment: 1,
          },
        },
      });

      if (this.analytics) {
        await this.analytics.updateDailyThread(ContentTarget.POST, postId, +1);
      }

      // Notify post owner
      try {
        if (
          updatedPost.userId &&
          updatedPost.userId !== userId &&
          this.notifications
        ) {
          await this.notifications.create(
            updatedPost.userId,
            NotificationType.THREAD,
            {
              actorId: userId,
              payload: { postId, targetType: 'POST' },
              dedupeMs: 5 * 60 * 1000,
            },
          );
        }
      } catch {}

      // Notify patchers about engagement on brand content
      if (this.notifications && post.user?.type === UserType.BRAND) {
        const patchers = await this.prisma.patchConnection.findMany({
          where: {
            targetId: post.userId,
            status: PatchStatus.ACCEPTED,
            mode: PatchMode.USER_TO_BRAND,
          },
          select: { requesterId: true },
        });
        const message = 'threaded post';

        const recipientIds = patchers
          .map((p) => p.requesterId)
          .filter((id) => id && id !== userId);

        if (recipientIds.length > 0 && this.notificationsQueue) {
          try {
            await this.notificationsQueue.enqueueFanout({
              recipientIds,
              notificationType: NotificationType.THREAD,
              actorId: userId,
              payload: {
                postId,
                targetType: 'POST',
                targetUrl: `/posts/${postId}`,
                message,
              },
              dedupeMs: 2 * 60 * 1000,
            });
          } catch (e) {
            console.warn('Failed to enqueue thread fanout', e);
          }
        } else if (recipientIds.length > 0) {
          for (const recipientId of recipientIds) {
            try {
              await this.notifications.create(
                recipientId,
                NotificationType.THREAD,
                {
                  actorId: userId,
                  payload: {
                    postId,
                    targetType: 'POST',
                    targetUrl: `/posts/${postId}`,
                    message,
                  },
                  dedupeMs: 2 * 60 * 1000,
                },
              );
            } catch (e) {
              console.warn('Failed to notify patcher of post thread', e);
            }
          }
        }
      }

      return {
        threaded: true,
        threadsCount: updatedPost.threadsCount,
      };
    }
  }

  async getThreads(postId: string): Promise<{ users: any[]; total: number }> {
    const [threads, count] = await Promise.all([
      this.prisma.thread.findMany({
        where: { postId },
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              userProfile: { select: canonicalUserProfileSelect },
              brand: { select: canonicalBrandProfileSelect },
            },
          },
        },
        take: 10, // Just get the latest 10 users who threaded
      }),
      this.prisma.thread.count({
        where: { postId },
      }),
    ]);

    return {
      users: threads.map((thread) => this.mapUserDisplay(thread.user)),
      total: count,
    };
  }

  async isThreaded(postId: string, userId: string): Promise<boolean> {
    const thread = await this.prisma.thread.findUnique({
      where: {
        postId_userId: {
          postId,
          userId,
        },
      },
    });

    return !!thread;
  }
}
