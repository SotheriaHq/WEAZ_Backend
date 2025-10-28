import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { CreateFollowDto } from './dto/create-follow.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async follow(userId: string, dto: CreateFollowDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: dto.targetId },
    });
    if (!target) throw new BadRequestException('Target user not found');
    if (dto.targetId === userId)
      throw new BadRequestException('Cannot follow yourself');

    try {
      const follow = await this.prisma.follow.create({
        data: {
          id: uuidv4(),
          followerId: userId,
          followingId: dto.targetId,
        },
      });
      // Notify the target user
      if (dto.targetId !== userId) {
        try {
          await this.notifications.create(
            dto.targetId,
            NotificationType.FOLLOW,
            {
              actorId: userId,
              payload: {},
            },
          );
        } catch {}
      }

      return follow;
    } catch (error) {
      // Unique constraint -> already following
      if (error.code === 'P2002') {
        throw new BadRequestException('Already following this user');
      }
      throw error;
    }
  }

  async unfollow(userId: string, targetId: string) {
    const existing = await this.prisma.follow
      .findUnique({
        where: {
          followerId_followingId: { followerId: userId, followingId: targetId },
        },
      })
      .catch(() => null);
    if (!existing) throw new BadRequestException('Not following this user');

    await this.prisma.follow.delete({ where: { id: existing.id } });
    return { message: 'Unfollowed' };
  }

  async getFollowers(userId: string, limit = 20, cursor?: string) {
    const where = { followingId: userId };
    const items = await this.prisma.follow.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        follower: {
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

    return {
      items,
      hasNextPage: items.length === limit,
      endCursor: items.length ? items[items.length - 1].id : null,
    };
  }

  async getFollowing(userId: string, limit = 20, cursor?: string) {
    const where = { followerId: userId };
    const items = await this.prisma.follow.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        following: {
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

    return {
      items,
      hasNextPage: items.length === limit,
      endCursor: items.length ? items[items.length - 1].id : null,
    };
  }
}
