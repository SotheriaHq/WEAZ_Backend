import { Injectable } from '@nestjs/common';
import {
  CustomOrderStatus,
  MessageContextType,
  MessageKind,
  MessageParticipantRole,
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
    const thread =
      (await this.prisma.messageThread.findUnique({
        where: { customOrderId: params.customOrderId },
        include: { participants: true },
      })) ??
      (await this.prisma.messageThread.create({
        data: {
          contextType: MessageContextType.CUSTOM_ORDER,
          customOrderId: params.customOrderId,
          brandId: params.brandId,
          buyerId: params.buyerId,
          status: this.policy.resolveThreadStatusForCustomOrder(params.status),
          subjectSnapshotJson: {
            title: params.sourceTitle,
            type: 'CUSTOM_ORDER',
          } as Prisma.InputJsonValue,
          participants: {
            create: [
              { userId: params.buyerId, role: MessageParticipantRole.BUYER },
              { userId: params.brandOwnerUserId, role: MessageParticipantRole.BRAND_OWNER },
            ],
          },
        },
        include: { participants: true },
      }));

    const missingParticipantRows = [
      { userId: params.buyerId, role: MessageParticipantRole.BUYER },
      { userId: params.brandOwnerUserId, role: MessageParticipantRole.BRAND_OWNER },
    ].filter(
      (candidate) =>
        !thread.participants.some(
          (participant) =>
            participant.userId === candidate.userId && participant.role === candidate.role,
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
          lastMessagePreview: String(existingPlacementMessage.bodyText ?? '').slice(0, 200),
          lastSenderUserId: null,
          status: this.policy.resolveThreadStatusForCustomOrder(params.status),
        },
      });
      return { threadId: thread.id, messageId: existingPlacementMessage.id };
    }

    const bodyText = `A new custom order for "${params.sourceTitle}" has been placed by ${params.buyerDisplayName}.`;
    const message = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: null,
        senderRole: MessageParticipantRole.SYSTEM,
        kind: MessageKind.SYSTEM,
        bodyText,
        metadataJson: {
          eventType: 'CUSTOM_ORDER_PLACED',
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
        status: this.policy.resolveThreadStatusForCustomOrder(params.status),
      },
    });

    await this.prisma.messageNotificationOutbox.create({
      data: {
        threadId: thread.id,
        messageId: message.id,
        recipientId: params.brandOwnerUserId,
        notificationType: NotificationType.MESSAGE_RECEIVED,
        payloadJson: {
          threadId: thread.id,
          messageId: message.id,
          contextType: thread.contextType,
          customOrderId: params.customOrderId,
          actionType: 'CUSTOM_ORDER_PLACED',
          targetUrl: `/studio/messages?thread=${thread.id}&messageId=${message.id}&customOrderId=${params.customOrderId}`,
        } as Prisma.InputJsonValue,
      },
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
