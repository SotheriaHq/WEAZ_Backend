import { Injectable } from '@nestjs/common';
import {
  CustomOrderStatus,
  MessageConversationType,
  MessageContextType,
  MessageKind,
  MessageParticipantRole,
  MessageThreadStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';

@Injectable()
export class CustomOrderThreadBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: MessagingPolicyService,
    private readonly sideEffects: MessagingSideEffectsService,
  ) {}

  private buildPairKey(buyerId: string, brandId: string) {
    return `BUYER_BRAND:${buyerId}:${brandId}`;
  }

  private resolveThreadTargetUrl(
    customOrderId: string,
    recipientRole: MessageParticipantRole,
  ): string {
    if (recipientRole === MessageParticipantRole.BRAND_OWNER) {
      return `/studio/custom-orders/${customOrderId}#messages`;
    }

    if (recipientRole === MessageParticipantRole.ADMIN) {
      return `/admin/custom-orders/${customOrderId}#messages`;
    }

    return `/custom-orders/${customOrderId}#messages`;
  }

  async ensureOrderPlacedThread(params: {
    customOrderId: string;
    status: CustomOrderStatus;
    brandId: string;
    buyerId: string;
    brandOwnerUserId: string;
    actorId: string;
    buyerDisplayName: string;
    sourceTitle: string;
  }) {
    const pairKey = this.buildPairKey(params.buyerId, params.brandId);
    const thread = await this.prisma.$transaction(async (tx) => {
      const linked = await tx.messageThreadOrderLink.findUnique({
        where: { customOrderId: params.customOrderId },
        include: { thread: { include: { participants: true } } },
      });
      if (linked?.thread) return linked.thread;

      const existingPair = await tx.messageThread.findFirst({
        where: { pairKey },
        include: { participants: true },
      });
      if (existingPair) {
        await tx.messageThreadOrderLink.upsert({
          where: { customOrderId: params.customOrderId },
          create: {
            threadId: existingPair.id,
            customOrderId: params.customOrderId,
          },
          update: { threadId: existingPair.id },
        });
        return existingPair;
      }

      const legacyPair = await tx.messageThread.findFirst({
        where: {
          pairKey: null,
          brandId: params.brandId,
          buyerId: params.buyerId,
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        include: { participants: true },
      });
      if (legacyPair) {
        const updated = await tx.messageThread.update({
          where: { id: legacyPair.id },
          data: {
            contextType: MessageContextType.DIRECT,
            conversationType: MessageConversationType.BUYER_BRAND,
            buyerUserId: params.buyerId,
            brandOwnerUserId: params.brandOwnerUserId,
            pairKey,
            status: MessageThreadStatus.OPEN,
          },
          include: { participants: true },
        });
        await tx.messageThreadOrderLink.upsert({
          where: { customOrderId: params.customOrderId },
          create: { threadId: updated.id, customOrderId: params.customOrderId },
          update: { threadId: updated.id },
        });
        return updated;
      }

      const created = await tx.messageThread.create({
        data: {
          contextType: MessageContextType.DIRECT,
          conversationType: MessageConversationType.BUYER_BRAND,
          brandId: params.brandId,
          buyerId: params.buyerId,
          buyerUserId: params.buyerId,
          brandOwnerUserId: params.brandOwnerUserId,
          pairKey,
          status: this.policy.resolveThreadStatusForCustomOrder(params.status),
          subjectSnapshotJson: {
            title: params.sourceTitle,
            type: 'BUYER_BRAND_CONVERSATION',
          } as Prisma.InputJsonValue,
          participants: {
            create: [
              { userId: params.buyerId, role: MessageParticipantRole.BUYER },
              {
                userId: params.brandOwnerUserId,
                role: MessageParticipantRole.BRAND_OWNER,
              },
            ],
          },
        },
        include: { participants: true },
      });

      await tx.messageThreadOrderLink.create({
        data: { threadId: created.id, customOrderId: params.customOrderId },
      });
      return created;
    });

    const missingParticipantRows = [
      { userId: params.buyerId, role: MessageParticipantRole.BUYER },
      {
        userId: params.brandOwnerUserId,
        role: MessageParticipantRole.BRAND_OWNER,
      },
    ].filter(
      (candidate) =>
        !thread.participants.some(
          (participant) =>
            participant.userId === candidate.userId &&
            participant.role === candidate.role,
        ),
    );

    if (missingParticipantRows.length > 0) {
      await this.prisma.messageThreadParticipant.createMany({
        data: missingParticipantRows.map((candidate) => ({
          threadId: thread.id,
          userId: candidate.userId,
          role: candidate.role,
        })),
        skipDuplicates: true,
      });
    }

    const existingPlacementMessage = await this.prisma.message.findFirst({
      where: {
        threadId: thread.id,
        customOrderId: params.customOrderId,
        kind: MessageKind.SYSTEM,
        metadataJson: {
          path: ['eventType'],
          equals: 'CUSTOM_ORDER_PLACED',
        },
      },
      select: { id: true, createdAt: true, bodyText: true },
    });

    if (existingPlacementMessage) {
      await this.prisma.messageThread.update({
        where: { id: thread.id },
        data: {
          lastMessageId: existingPlacementMessage.id,
          lastMessageAt: existingPlacementMessage.createdAt,
          lastVisibleMessageAt: existingPlacementMessage.createdAt,
          lastMessagePreview: String(
            existingPlacementMessage.bodyText ?? '',
          ).slice(0, 200),
          lastSenderUserId: null,
        },
      });
      return { threadId: thread.id, messageId: existingPlacementMessage.id };
    }

    const bodyText = `A new custom order for "${params.sourceTitle}" has been placed by ${params.buyerDisplayName}.`;
    const message = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        contextType: MessageContextType.CUSTOM_ORDER,
        customOrderId: params.customOrderId,
        senderUserId: null,
        senderRole: MessageParticipantRole.SYSTEM,
        kind: MessageKind.SYSTEM,
        bodyText,
        metadataJson: {
          eventType: 'CUSTOM_ORDER_PLACED',
          customOrderId: params.customOrderId,
          source: 'CUSTOM_ORDER_BOOTSTRAP',
          actorId: params.actorId,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastVisibleMessageAt: message.createdAt,
        lastMessagePreview: bodyText.slice(0, 200),
        lastSenderUserId: null,
      },
    });

    await this.prisma.messageNotificationOutbox.createMany({
      data: [
        {
          threadId: thread.id,
          messageId: message.id,
          recipientId: params.brandOwnerUserId,
          notificationType: NotificationType.MESSAGE_RECEIVED,
          payloadJson: {
            type: 'message',
            category: 'message',
            threadId: thread.id,
            conversationId: thread.id,
            messageId: message.id,
            contextType: thread.contextType,
            customOrderId: params.customOrderId,
            orderId: null,
            brandId: params.brandId,
            customerId: params.buyerId,
            actorUserId: params.actorId,
            actionType: 'CUSTOM_ORDER_PLACED',
            message: bodyText,
            targetUrl: this.resolveThreadTargetUrl(
              params.customOrderId,
              MessageParticipantRole.BRAND_OWNER,
            ),
          } as Prisma.InputJsonValue,
        },
        {
          threadId: thread.id,
          messageId: message.id,
          recipientId: params.buyerId,
          notificationType: NotificationType.MESSAGE_RECEIVED,
          payloadJson: {
            type: 'message',
            category: 'message',
            threadId: thread.id,
            conversationId: thread.id,
            messageId: message.id,
            contextType: thread.contextType,
            customOrderId: params.customOrderId,
            orderId: null,
            brandId: params.brandId,
            customerId: params.buyerId,
            actorUserId: params.actorId,
            actionType: 'CUSTOM_ORDER_PLACED',
            message: bodyText,
            targetUrl: this.resolveThreadTargetUrl(
              params.customOrderId,
              MessageParticipantRole.BUYER,
            ),
          } as Prisma.InputJsonValue,
        },
      ],
    });

    await this.sideEffects.dispatchMessageOutboxForMessage(message.id);
    const recipientIds = [params.buyerId, params.brandOwnerUserId];
    this.sideEffects.emitMessageCreated(thread, recipientIds, {
      id: message.id,
      senderRole: message.senderRole,
      createdAt: message.createdAt,
    });
    this.sideEffects.emitThreadInvalidation(thread, recipientIds);

    return { threadId: thread.id, messageId: message.id };
  }
}
