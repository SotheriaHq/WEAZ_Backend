import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MessageThreadStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import {
  BRAND_PERMISSIONS,
  BrandPermissionCode,
} from 'src/brands/permissions/brand-permissions';
import { MessagingPolicyService } from './messaging-policy.service';

@Injectable()
export class MessagingAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandPermissionService: BrandPermissionService,
    private readonly policy: MessagingPolicyService,
  ) {}

  async resolveThreadBrandId(threadId: string): Promise<string | null> {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: {
        brandId: true,
        order: { select: { brandId: true } },
        customOrder: { select: { brandId: true } },
      },
    });
    if (!thread) {
      throw new NotFoundException('Message thread not found');
    }
    return thread.brandId ?? thread.order?.brandId ?? thread.customOrder?.brandId ?? null;
  }

  async assertThreadParticipantRead(userId: string, threadId: string): Promise<void> {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: { id: true },
    });
    if (!participant) {
      throw new ForbiddenException('Thread access denied');
    }
  }

  async assertThreadBrandRead(userId: string, threadId: string): Promise<void> {
    const brandId = await this.resolveThreadBrandId(threadId);
    if (!brandId) {
      throw new ForbiddenException('Thread access denied');
    }
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.MESSAGES_READ,
    );
  }

  async assertThreadBrandReply(userId: string, threadId: string): Promise<void> {
    const brandId = await this.resolveThreadBrandId(threadId);
    if (!brandId) {
      throw new ForbiddenException('Thread access denied');
    }
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.MESSAGES_REPLY,
    );
  }

  async assertBrandRead(userId: string, brandIdOrOwnerId: string): Promise<void> {
    await this.brandPermissionService.assertPermission(
      userId,
      brandIdOrOwnerId,
      BRAND_PERMISSIONS.MESSAGES_READ,
    );
  }

  async assertBrandReply(userId: string, brandIdOrOwnerId: string): Promise<void> {
    await this.brandPermissionService.assertPermission(
      userId,
      brandIdOrOwnerId,
      BRAND_PERMISSIONS.MESSAGES_REPLY,
    );
  }

  async assertCanReadThread(userId: string, threadId: string): Promise<void> {
    if (await this.hasDirectParticipant(userId, threadId)) {
      return;
    }
    await this.assertThreadBrandRead(userId, threadId);
  }

  async assertCanSendMessage(userId: string, threadId: string): Promise<void> {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { status: true },
    });
    if (!thread) {
      throw new NotFoundException('Message thread not found');
    }
    if (await this.hasDirectParticipant(userId, threadId)) {
      this.policy.assertCanSend(thread.status);
      return;
    }
    await this.assertThreadBrandReply(userId, threadId);
    this.policy.assertCanSend(thread.status);
  }

  async canReadThread(userId: string, threadId: string): Promise<boolean> {
    try {
      await this.assertCanReadThread(userId, threadId);
      return true;
    } catch {
      return false;
    }
  }

  async canSendMessage(userId: string, threadId: string): Promise<boolean> {
    try {
      await this.assertCanSendMessage(userId, threadId);
      return true;
    } catch {
      return false;
    }
  }

  async getBrandIdsWithPermission(
    userId: string,
    permission: BrandPermissionCode,
  ): Promise<string[]> {
    const [ownedBrands, memberships] = await Promise.all([
      this.prisma.brand.findMany({
        where: { ownerId: userId },
        select: { id: true },
      }),
      this.prisma.brandMember.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { brandId: true },
      }),
    ]);

    const brandIds = Array.from(
      new Set([
        ...ownedBrands.map((brand) => brand.id),
        ...memberships.map((membership) => membership.brandId),
      ]),
    );

    const allowed = await Promise.all(
      brandIds.map(async (brandId) => ({
        brandId,
        allowed: await this.brandPermissionService.hasPermission(userId, brandId, permission),
      })),
    );
    return allowed.filter((entry) => entry.allowed).map((entry) => entry.brandId);
  }

  async resolveActorThreadRole(userId: string, threadId: string) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: { role: true },
    });
    if (participant) {
      return participant.role;
    }
    if (await this.canSendMessage(userId, threadId)) {
      return 'BRAND_OWNER' as const;
    }
    throw new ForbiddenException('Thread access denied');
  }

  private async hasDirectParticipant(userId: string, threadId: string): Promise<boolean> {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
      select: { id: true },
    });
    return Boolean(participant);
  }

  assertThreadWritable(status: MessageThreadStatus): void {
    this.policy.assertCanSend(status);
  }
}
