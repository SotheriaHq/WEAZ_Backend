import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
type CommentTarget = 'POST' | 'COLLECTION' | 'COLLECTION_MEDIA';
import type { CommentV2 as PrismaCommentV2 } from '@prisma/client';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationsService } from 'src/notifications/notifications.service';
import { CreateCommentV2Dto, ListQueryDto } from './dto';
import {
  NotificationType,
  CollectionVisibility,
  AccessState,
} from '@prisma/client';

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class CommentsV2Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
  ) {}

  private async canViewCollection(collectionId: string, requesterId?: string) {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, status: true, visibility: true },
    });
    if (!c || c.status !== 'PUBLISHED') return false;
    if (c.visibility === CollectionVisibility.PUBLIC) return true;
    if (requesterId && requesterId === c.ownerId) return true;
    if (requesterId) {
      const access = await this.prisma.collectionAccess.findUnique({
        where: {
          collectionId_viewerId: { collectionId, viewerId: requesterId },
        },
        select: { state: true },
      });
      return access?.state === AccessState.APPROVED;
    }
    return false;
  }

  private async canViewMedia(mediaId: string, requesterId?: string) {
    const m = await this.prisma.collectionMedia.findUnique({
      where: { id: mediaId },
      select: { collectionId: true },
    });
    if (!m) return false;
    return this.canViewCollection(m.collectionId, requesterId);
  }

  private async assertTargetExists(
    targetType: CommentTarget,
    targetId: string,
  ) {
    if (targetType === 'POST') {
      const post = await this.prisma.post.findUnique({
        where: { id: targetId },
      });
      if (!post) throw new NotFoundException('Post not found');
      return { ownerId: post.userId };
    }
    if (targetType === 'COLLECTION') {
      const coll = await this.prisma.collection.findUnique({
        where: { id: targetId },
      });
      if (!coll) throw new NotFoundException('Collection not found');
      return { ownerId: coll.ownerId };
    }
    if (targetType === 'COLLECTION_MEDIA') {
      const media = await this.prisma.collectionMedia.findUnique({
        where: { id: targetId },
        include: { collection: true },
      });
      if (!media) throw new NotFoundException('Media not found');
      return { ownerId: media.collection.ownerId };
    }
    throw new BadRequestException('Invalid target');
  }

  async createForTarget(
    targetType: CommentTarget,
    targetId: string,
    userId: string,
    dto: CreateCommentV2Dto,
  ) {
    await this.assertTargetExists(targetType, targetId);
    if (targetType === 'COLLECTION') {
      const ok = await this.canViewCollection(targetId, userId);
      if (!ok) throw new NotFoundException('Collection not found');
    }
    if (targetType === 'COLLECTION_MEDIA') {
      const ok = await this.canViewMedia(targetId, userId);
      if (!ok) throw new NotFoundException('Media not found');
    }

    let parent: PrismaCommentV2 | null = null;
    if (dto.parentId) {
      parent = await this.prisma.commentV2.findUnique({
        where: { id: dto.parentId },
      });
      if (!parent) throw new NotFoundException('Parent comment not found');
      if (parent.targetType !== targetType || parent.targetId !== targetId) {
        throw new BadRequestException('Parent target mismatch');
      }
      if (parent.depth >= 2)
        throw new BadRequestException('Max reply depth reached');
    }

    const now = new Date();
    const contentRaw = (dto.content ?? '').trim();
    if (contentRaw.length < 1 || contentRaw.length > 500)
      throw new BadRequestException('Content must be 1-500 chars');
    const sanitized = escapeHtml(contentRaw);

    const created = await this.prisma.$transaction(async (tx) => {
      const createdComment = await tx.commentV2.create({
        data: {
          id: uuidv4(),
          targetType,
          targetId,
          userId,
          parentId: dto.parentId ?? null,
          depth: parent ? parent.depth + 1 : 0,
          contentRaw,
          contentSanitized: sanitized,
          createdAt: now,
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

      if (parent) {
        await tx.commentV2.update({
          where: { id: parent.id },
          data: { replyCount: { increment: 1 } },
        });
      }

      if (targetType === 'POST') {
        await tx.post.update({
          where: { id: targetId },
          data: { commentsCount: { increment: 1 } },
        });
      } else if (targetType === 'COLLECTION') {
        await tx.collection.update({
          where: { id: targetId },
          data: { commentsCount: { increment: 1 } },
        });
      } else if (targetType === 'COLLECTION_MEDIA') {
        await tx.collectionMedia.update({
          where: { id: targetId },
          data: { commentsCount: { increment: 1 } },
        });
      }

      return createdComment;
    });

    // Emit realtime with enriched payload so clients can patch incrementally without refetch
    const room = `${targetType}:${targetId}`;
    try {
      this.events.server?.to(room).emit('comment.created', {
        targetType,
        targetId,
        commentId: created.id,
        userId,
        at: Date.now(),
        comment: {
          id: created.id,
          targetType,
          targetId,
          user: created.user,
          userId: created.userId,
          parentId: created.parentId,
          depth: created.depth,
          contentSanitized: created.contentSanitized,
          likeCount: 0,
          replyCount: 0,
          createdAt: created.createdAt,
          deletedAt: null,
          isLikedByMe: false,
          children: [],
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to emit comment.created', e);
    }

    // Notify target owner
    try {
      let ownerId: string | null = null;
      if (targetType === 'POST') {
        const post = await this.prisma.post.findUnique({
          where: { id: targetId },
        });
        ownerId = post?.userId ?? null;
      } else if (targetType === 'COLLECTION') {
        const coll = await this.prisma.collection.findUnique({
          where: { id: targetId },
        });
        ownerId = coll?.ownerId ?? null;
      } else if (targetType === 'COLLECTION_MEDIA') {
        const media = await this.prisma.collectionMedia.findUnique({
          where: { id: targetId },
          include: { collection: true },
        });
        ownerId = media?.collection.ownerId ?? null;
      }

      if (ownerId && ownerId !== userId) {
        let targetUrl = '';
        if (targetType === 'COLLECTION') {
          targetUrl = `/collections/${targetId}?commentId=${created.id}`;
        } else if (targetType === 'COLLECTION_MEDIA') {
          // We fetched media earlier to check permissions, but let's ensure we have collectionId
          // If we didn't fetch it in assertTargetExists (we did), we might need to fetch again or pass it down.
          // assertTargetExists returns { ownerId } but not collectionId.
          // Let's fetch it quickly or optimize.
          const media = await this.prisma.collectionMedia.findUnique({
            where: { id: targetId },
            select: { collectionId: true },
          });
          if (media) {
            targetUrl = `/collections/${media.collectionId}?commentId=${created.id}`;
          }
        } else if (targetType === 'POST') {
          targetUrl = `/posts/${targetId}?commentId=${created.id}`;
        }

        await this.notifications.create(ownerId, NotificationType.COMMENT, {
          actorId: userId,
          payload: { targetType, targetId, targetUrl },
        });
      }

      // Notify parent comment author for replies
      if (created.parentId) {
        const parent = await this.prisma.commentV2.findUnique({
          where: { id: created.parentId },
        });
        const parentAuthorId = parent?.userId;
        if (
          parentAuthorId &&
          parentAuthorId !== userId &&
          parentAuthorId !== (ownerId ?? '')
        ) {
          await this.notifications.create(
            parentAuthorId,
            NotificationType.COMMENT,
            {
              actorId: userId,
              payload: { targetType, targetId, parentId: created.parentId },
            },
          );
        }
      }
    } catch {}

    return created;
  }

  async listForTarget(
    targetType: CommentTarget,
    targetId: string,
    requesterId: string | undefined,
    q: ListQueryDto,
  ) {
    await this.assertTargetExists(targetType, targetId);
    if (targetType === 'COLLECTION') {
      const ok = await this.canViewCollection(targetId, requesterId);
      if (!ok) throw new NotFoundException('Collection not found');
    }
    if (targetType === 'COLLECTION_MEDIA') {
      const ok = await this.canViewMedia(targetId, requesterId);
      if (!ok) throw new NotFoundException('Media not found');
    }
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
    const cursorDate = q.cursor ? new Date(q.cursor) : undefined;

    const items = await this.prisma.commentV2.findMany({
      where: {
        targetType,
        targetId,
        depth: 0,
        deletedAt: null,
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      orderBy: { createdAt: 'desc' },
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
        children: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 2,
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
        },
      },
    });
    const hasNextPage = items.length > limit;
    const data = hasNextPage ? items.slice(0, -1) : items;

    // isLikedByMe for visible comments
    const ids = data.flatMap((c) => [c.id, ...c.children.map((r) => r.id)]);
    let likedSet = new Set<string>();
    if (requesterId && ids.length) {
      const liked = await this.prisma.commentV2Like.findMany({
        where: { userId: requesterId, commentId: { in: ids } },
        select: { commentId: true },
      });
      likedSet = new Set(liked.map((l) => l.commentId));
    }

    return {
      items: data.map((c) => ({
        ...c,
        isLikedByMe: requesterId ? likedSet.has(c.id) : false,
        children: c.children.map((r) => ({
          ...r,
          isLikedByMe: requesterId ? likedSet.has(r.id) : false,
        })),
      })),
      hasNextPage,
      endCursor: data.length
        ? data[data.length - 1].createdAt.toISOString()
        : null,
    };
  }

  async getReplies(
    commentId: string,
    requesterId: string | undefined,
    q: ListQueryDto,
  ) {
    const parent = await this.prisma.commentV2.findUnique({
      where: { id: commentId },
      select: { id: true, targetType: true, targetId: true },
    });
    if (!parent) throw new NotFoundException('Comment not found');
    if (parent.targetType === 'COLLECTION') {
      const ok = await this.canViewCollection(parent.targetId, requesterId);
      if (!ok) throw new NotFoundException('Collection not found');
    }
    if (parent.targetType === 'COLLECTION_MEDIA') {
      const ok = await this.canViewMedia(parent.targetId, requesterId);
      if (!ok) throw new NotFoundException('Media not found');
    }
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const cursorDate = q.cursor ? new Date(q.cursor) : undefined;
    const items = await this.prisma.commentV2.findMany({
      where: {
        parentId: commentId,
        deletedAt: null,
        ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
      },
      orderBy: { createdAt: 'desc' },
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

    let likedSet = new Set<string>();
    if (requesterId && data.length) {
      const liked = await this.prisma.commentV2Like.findMany({
        where: {
          userId: requesterId,
          commentId: { in: data.map((d) => d.id) },
        },
        select: { commentId: true },
      });
      likedSet = new Set(liked.map((l) => l.commentId));
    }

    return {
      items: data.map((r) => ({
        ...r,
        isLikedByMe: requesterId ? likedSet.has(r.id) : false,
      })),
      hasNextPage,
      endCursor: data.length
        ? data[data.length - 1].createdAt.toISOString()
        : null,
    };
  }

  async toggleLike(commentId: string, userId: string, clientEventId?: string) {
    const comment = await this.prisma.commentV2.findUnique({
      where: { id: commentId },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    const existing = await this.prisma.commentV2Like
      .findUnique({ where: { commentId_userId: { commentId, userId } } })
      .catch(() => null);

    const liked = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.commentV2Like.delete({
          where: { commentId_userId: { commentId, userId } },
        });
        const updated = await tx.commentV2.update({
          where: { id: commentId },
          data: { likeCount: { decrement: 1 } },
        });
        return { liked: false, likeCount: updated.likeCount };
      } else {
        await tx.commentV2Like.create({
          data: { id: uuidv4(), commentId, userId },
        });
        const updated = await tx.commentV2.update({
          where: { id: commentId },
          data: { likeCount: { increment: 1 } },
        });
        return { liked: true, likeCount: updated.likeCount };
      }
    });

    const room = `COMMENT:${commentId}`;
    this.events.server?.to(room).emit('comment.liked', {
      commentId,
      userId,
      likeCount: liked.likeCount,
      at: Date.now(),
      clientEventId,
    });
    return liked;
  }

  async isLiked(commentId: string, userId: string) {
    const liked = await this.prisma.commentV2Like.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });
    return { liked: !!liked };
  }

  async softDelete(commentId: string, requesterId: string) {
    const c = await this.prisma.commentV2.findUnique({
      where: { id: commentId },
    });
    if (!c) throw new NotFoundException('Comment not found');

    const { ownerId } = await this.assertTargetExists(c.targetType, c.targetId);
    if (c.userId !== requesterId && ownerId !== requesterId) {
      throw new ForbiddenException('Not allowed to delete this comment');
    }

    await this.prisma.$transaction(async (tx) => {
      // Soft delete by setting deletedAt and clearing sanitized text
      await tx.commentV2.update({
        where: { id: commentId },
        data: { deletedAt: new Date(), contentSanitized: '[deleted]' },
      });

      if (c.parentId) {
        await tx.commentV2.update({
          where: { id: c.parentId },
          data: { replyCount: { decrement: 1 } },
        });
      }

      if (c.targetType === 'POST') {
        await tx.post.update({
          where: { id: c.targetId },
          data: { commentsCount: { decrement: 1 } },
        });
      } else if (c.targetType === 'COLLECTION') {
        await tx.collection.update({
          where: { id: c.targetId },
          data: { commentsCount: { decrement: 1 } },
        });
      } else if (c.targetType === 'COLLECTION_MEDIA') {
        await tx.collectionMedia.update({
          where: { id: c.targetId },
          data: { commentsCount: { decrement: 1 } },
        });
      }
    });

    const room = `${c.targetType}:${c.targetId}`;
    try {
      this.events.server?.to(room).emit('comment.deleted', {
        commentId,
        at: Date.now(),
        targetType: c.targetType,
        targetId: c.targetId,
        deleted: true,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to emit comment.deleted', e);
    }
    return { success: true };
  }

  async getStats(commentId: string) {
    const c = await this.prisma.commentV2.findUnique({
      where: { id: commentId },
    });
    if (!c) throw new NotFoundException('Comment not found');
    return { likeCount: c.likeCount, replyCount: c.replyCount };
  }

  // Unified comment list for a collection: includes comments made on the collection
  // and comments made on any media belonging to that collection. Top-level only with last 2 replies.
  async listUnifiedForCollection(
    collectionId: string,
    requesterId: string | undefined,
    q: ListQueryDto,
  ) {
    const ok = await this.canViewCollection(collectionId, requesterId);
    if (!ok) throw new NotFoundException('Collection not found');

    // Gather media ids once
    const medias = await this.prisma.collectionMedia.findMany({
      where: { collectionId },
      select: { id: true },
    });
    const mediaIds = medias.map((m) => m.id);

    const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
    const cursorDate = q.cursor ? new Date(q.cursor) : undefined;

    const where: any = {
      OR: [
        { targetType: 'COLLECTION', targetId: collectionId },
        mediaIds.length
          ? { targetType: 'COLLECTION_MEDIA', targetId: { in: mediaIds } }
          : undefined,
      ].filter(Boolean),
      depth: 0,
      deletedAt: null,
      ...(cursorDate ? { createdAt: { lt: cursorDate } } : {}),
    };

    const rows = await this.prisma.commentV2.findMany({
      where,
      orderBy: { createdAt: 'desc' },
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
        children: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 2,
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
        },
      },
    });

    const hasNextPage = rows.length > limit;
    const data = hasNextPage ? rows.slice(0, -1) : rows;

    // Like state for visible comments
    const ids = data.flatMap((c) => [c.id, ...c.children.map((r) => r.id)]);
    let likedSet = new Set<string>();
    if (requesterId && ids.length) {
      const liked = await this.prisma.commentV2Like.findMany({
        where: { userId: requesterId, commentId: { in: ids } },
        select: { commentId: true },
      });
      likedSet = new Set(liked.map((l) => l.commentId));
    }

    return {
      items: data.map((c) => ({
        ...c,
        isLikedByMe: requesterId ? likedSet.has(c.id) : false,
        children: c.children.map((r) => ({
          ...r,
          isLikedByMe: requesterId ? likedSet.has(r.id) : false,
        })),
      })),
      hasNextPage,
      endCursor: data.length
        ? data[data.length - 1].createdAt.toISOString()
        : null,
    };
  }
}
