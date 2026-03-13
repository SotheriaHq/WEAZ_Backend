import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  CustomOrderStatus,
  MessageContextType,
  MessageKind,
  MessageParticipantRole,
  MessageThreadStatus,
  NotificationType,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { Request } from 'express';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';
import {
  AdminSystemMessageDto,
  MarkThreadReadDto,
  QueryMessagesDto,
  QueryThreadSummaryDto,
  SendMessageDto,
} from './dto/messaging.dto';

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAudit: AdminAuditService,
    private readonly attachments: MessagingAttachmentService,
    private readonly policy: MessagingPolicyService,
    private readonly query: MessagingQueryService,
    private readonly sideEffects: MessagingSideEffectsService,
  ) {}

  async listCustomOrderMessagesForBuyer(actorId: string, customOrderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BUYER');
    const thread = await this.getOrCreateThreadForCustomOrder(resolved, false);
    if (!thread) return { items: [], hasNextPage: false, endCursor: null, thread: null };
    return {
      ...(await this.query.getMessages(thread.id, queryDto, { includeModerated: false })),
      thread,
    };
  }

  async listCustomOrderMessagesForBrand(actorId: string, brandId: string, customOrderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BRAND_OWNER', brandId);
    const thread = await this.getOrCreateThreadForCustomOrder(resolved, false);
    if (!thread) return { items: [], hasNextPage: false, endCursor: null, thread: null };
    return {
      ...(await this.query.getMessages(thread.id, queryDto, { includeModerated: false })),
      thread,
    };
  }

  async listOrderMessagesForBuyer(actorId: string, orderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BUYER');
    const thread = await this.getOrCreateThreadForOrder(resolved, true);
    return {
      ...(await this.query.getMessages(thread.id, queryDto, { includeModerated: false })),
      thread,
    };
  }

  async listOrderMessagesForBrand(actorId: string, brandId: string, orderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BRAND_OWNER', brandId);
    const thread = await this.getOrCreateThreadForOrder(resolved, true);
    return {
      ...(await this.query.getMessages(thread.id, queryDto, { includeModerated: false })),
      thread,
    };
  }

  async sendCustomOrderMessageForBuyer(actorId: string, customOrderId: string, dto: SendMessageDto, idempotencyKey?: string) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BUYER');
    return this.sendMessageInContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BUYER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      dto,
      idempotencyKey,
    });
  }

  async sendCustomOrderMessageForBrand(actorId: string, brandId: string, customOrderId: string, dto: SendMessageDto, idempotencyKey?: string) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BRAND_OWNER', brandId);
    return this.sendMessageInContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BRAND_OWNER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      dto,
      idempotencyKey,
    });
  }

  async sendOrderMessageForBuyer(actorId: string, orderId: string, dto: SendMessageDto, idempotencyKey?: string) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BUYER');
    return this.sendMessageInContext({
      contextType: MessageContextType.STANDARD_ORDER,
      contextId: orderId,
      actorId,
      actorRole: MessageParticipantRole.BUYER,
      threadStatus: this.policy.resolveThreadStatusForOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      dto,
      idempotencyKey,
    });
  }

  async sendOrderMessageForBrand(actorId: string, brandId: string, orderId: string, dto: SendMessageDto, idempotencyKey?: string) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BRAND_OWNER', brandId);
    return this.sendMessageInContext({
      contextType: MessageContextType.STANDARD_ORDER,
      contextId: orderId,
      actorId,
      actorRole: MessageParticipantRole.BRAND_OWNER,
      threadStatus: this.policy.resolveThreadStatusForOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      dto,
      idempotencyKey,
    });
  }

  async markThreadReadForContext(
    actorId: string,
    contextType: MessageContextType,
    contextId: string,
    role: 'BUYER' | 'BRAND_OWNER',
    dto: MarkThreadReadDto,
    brandId?: string,
  ) {
    if (contextType === MessageContextType.CUSTOM_ORDER) {
      await this.resolveCustomOrderContext(contextId, actorId, role, brandId);
    } else {
      await this.resolveStandardOrderContext(contextId, actorId, role, brandId);
    }

    const thread = await this.getThreadByContext(contextType, contextId);
    if (!thread) {
      return { success: true, threadId: null };
    }

    const upToMessage = dto.upToMessageId
      ? await this.prisma.message.findFirst({
          where: { id: dto.upToMessageId, threadId: thread.id },
          select: { id: true, createdAt: true },
        })
      : await this.prisma.message.findFirst({
          where: { threadId: thread.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, createdAt: true },
        });

    await this.prisma.messageThreadParticipant.upsert({
      where: { threadId_userId: { threadId: thread.id, userId: actorId } },
      update: {
        role,
        lastReadMessageId: upToMessage?.id ?? null,
        lastReadAt: upToMessage?.createdAt ?? new Date(),
      },
      create: {
        threadId: thread.id,
        userId: actorId,
        role,
        lastReadMessageId: upToMessage?.id ?? null,
        lastReadAt: upToMessage?.createdAt ?? new Date(),
      },
    });

    this.sideEffects.emitThreadInvalidation(thread, [actorId]);
    this.sideEffects.emitMessageRead(thread as any, actorId, upToMessage?.id ?? null);
    return { success: true, threadId: thread.id, lastReadMessageId: upToMessage?.id ?? null };
  }

  async getSummaryForContext(
    actorId: string,
    contextType: MessageContextType,
    contextId: string,
    role: 'BUYER' | 'BRAND_OWNER',
    queryDto: QueryThreadSummaryDto,
    brandId?: string,
  ) {
    if (contextType === MessageContextType.CUSTOM_ORDER) {
      await this.resolveCustomOrderContext(contextId, actorId, role, brandId);
    } else {
      await this.resolveStandardOrderContext(contextId, actorId, role, brandId);
    }

    const thread = await this.getThreadByContext(contextType, contextId);
    if (!thread) return null;

    return this.query.getSummaryForActor(
      thread.id,
      actorId,
      queryDto.includeUnreadCount === 'true',
    );
  }

  async getAdminThread(actorId: string, threadId: string) {
    return this.getThreadOrThrow(threadId);
  }

  async getAdminThreadMessages(actorId: string, threadId: string, queryDto: QueryMessagesDto) {
    await this.getThreadOrThrow(threadId);
    return this.query.getMessages(threadId, queryDto, { includeModerated: true });
  }

  async getAdminMessagesForContext(
    contextType: MessageContextType,
    contextId: string,
    queryDto: QueryMessagesDto,
  ) {
    const thread = await this.getThreadByContext(contextType, contextId);
    if (!thread) {
      return { items: [], hasNextPage: false, endCursor: null, thread: null };
    }

    return {
      ...(await this.query.getMessages(thread.id, queryDto, { includeModerated: true })),
      thread,
    };
  }

  async hideMessage(actorId: string, messageId: string, reason?: string, req?: Request) {
    const before = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        visibilityState: true,
        bodyText: true,
        threadId: true,
      },
    });
    if (!before) {
      throw new NotFoundException('Message not found');
    }

    const message = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        visibilityState: 'HIDDEN',
        moderatedById: actorId,
        moderatedAt: new Date(),
        moderationReason: reason ?? null,
      },
      include: { thread: true },
    });

    await this.adminAudit.log(
      {
        actorUserId: actorId,
        action: 'ADMIN_MESSAGING_MESSAGE_HIDE' as AdminAuditAction,
        targetType: 'MESSAGE',
        targetId: message.id,
        metadata: {
          reason: reason ?? null,
          threadId: message.threadId,
          contextType: message.thread.contextType,
          orderId: message.thread.orderId,
          customOrderId: message.thread.customOrderId,
        },
        previousState: {
          visibilityState: before.visibilityState,
          bodyText: before.bodyText,
        },
        newState: {
          visibilityState: message.visibilityState,
          bodyText: message.bodyText,
        },
      },
      req,
    );

    await this.notifyModeration(message.thread, message.id, actorId, reason);
    return { success: true, messageId: message.id };
  }

  async redactMessage(actorId: string, messageId: string, reason?: string, req?: Request) {
    const before = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        visibilityState: true,
        bodyText: true,
        threadId: true,
      },
    });
    if (!before) {
      throw new NotFoundException('Message not found');
    }

    const message = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        visibilityState: 'REDACTED',
        bodyText: null,
        moderatedById: actorId,
        moderatedAt: new Date(),
        moderationReason: reason ?? null,
      },
      include: { thread: true },
    });

    await this.adminAudit.log(
      {
        actorUserId: actorId,
        action: 'ADMIN_MESSAGING_MESSAGE_REDACT' as AdminAuditAction,
        targetType: 'MESSAGE',
        targetId: message.id,
        metadata: {
          reason: reason ?? null,
          threadId: message.threadId,
          contextType: message.thread.contextType,
          orderId: message.thread.orderId,
          customOrderId: message.thread.customOrderId,
        },
        previousState: {
          visibilityState: before.visibilityState,
          bodyText: before.bodyText,
        },
        newState: {
          visibilityState: message.visibilityState,
          bodyText: message.bodyText,
        },
      },
      req,
    );

    await this.notifyModeration(message.thread, message.id, actorId, reason);
    return { success: true, messageId: message.id };
  }

  async reopenThread(actorId: string, threadId: string, req?: Request) {
    const before = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        status: true,
        readOnlyAt: true,
        archivedAt: true,
      },
    });
    if (!before) {
      throw new NotFoundException('Thread not found');
    }

    const thread = await this.prisma.messageThread.update({
      where: { id: threadId },
      data: { status: MessageThreadStatus.OPEN, readOnlyAt: null },
      include: { participants: true },
    });

    const reopenMessage = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: null,
        senderRole: MessageParticipantRole.SYSTEM,
        kind: MessageKind.SYSTEM,
        bodyText: 'Thread reopened by admin',
        metadataJson: { action: 'THREAD_REOPENED', adminId: actorId } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: reopenMessage.id,
        lastMessageAt: reopenMessage.createdAt,
        lastVisibleMessageAt: reopenMessage.createdAt,
        lastMessagePreview: reopenMessage.bodyText?.slice(0, 200) ?? null,
        lastSenderUserId: null,
      },
    });

    const recipients = thread.participants.map((p) => ({ userId: p.userId, role: p.role }));
    for (const recipient of recipients) {
      await this.prisma.messageNotificationOutbox.create({
        data: {
          threadId: thread.id,
          messageId: reopenMessage.id,
          recipientId: recipient.userId,
          notificationType: NotificationType.MESSAGE_THREAD_REOPENED,
          payloadJson: {
            threadId: thread.id,
            contextType: thread.contextType,
            orderId: thread.orderId,
            customOrderId: thread.customOrderId,
            targetUrl: this.resolveThreadTargetUrl(
              thread.contextType,
              thread.orderId,
              thread.customOrderId,
              thread.brandId,
              recipient.role,
            ),
          } as Prisma.InputJsonValue,
        },
      });
    }

    this.sideEffects.emitThreadInvalidation(thread, recipients.map((recipient) => recipient.userId));

    await this.adminAudit.log(
      {
        actorUserId: actorId,
        action: 'ADMIN_MESSAGING_THREAD_REOPEN' as AdminAuditAction,
        targetType: 'MESSAGE_THREAD',
        targetId: thread.id,
        metadata: {
          contextType: thread.contextType,
          orderId: thread.orderId,
          customOrderId: thread.customOrderId,
        },
        previousState: {
          status: before.status,
          readOnlyAt: before.readOnlyAt,
          archivedAt: before.archivedAt,
        },
        newState: {
          status: thread.status,
          readOnlyAt: thread.readOnlyAt,
          archivedAt: thread.archivedAt,
        },
      },
      req,
    );

    return { success: true, threadId: thread.id };
  }

  async addSystemMessage(actorId: string, threadId: string, dto: AdminSystemMessageDto, req?: Request) {
    const thread = await this.getThreadOrThrow(threadId);
    const message = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: null,
        senderRole: MessageParticipantRole.SYSTEM,
        kind: MessageKind.SYSTEM,
        bodyText: dto.bodyText.trim(),
        metadataJson: { source: 'ADMIN', adminId: actorId } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastVisibleMessageAt: message.createdAt,
        lastMessagePreview: dto.bodyText.trim().slice(0, 200),
        lastSenderUserId: null,
      },
    });

    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId: thread.id },
      select: { userId: true },
    });
    this.sideEffects.emitMessageCreated(thread, participants.map((p) => p.userId), {
      id: message.id,
      senderRole: message.senderRole,
      createdAt: message.createdAt,
    });

    await this.adminAudit.log(
      {
        actorUserId: actorId,
        action: 'ADMIN_MESSAGING_SYSTEM_MESSAGE' as AdminAuditAction,
        targetType: 'MESSAGE_THREAD',
        targetId: thread.id,
        metadata: {
          messageId: message.id,
          bodyText: dto.bodyText.trim(),
          contextType: thread.contextType,
          orderId: thread.orderId,
          customOrderId: thread.customOrderId,
        },
      },
      req,
    );

    return { success: true, messageId: message.id };
  }

  private async sendMessageInContext(params: {
    contextType: MessageContextType;
    contextId: string;
    actorId: string;
    actorRole: 'BUYER' | 'BRAND_OWNER';
    threadStatus: MessageThreadStatus;
    brandId: string;
    buyerId: string | null;
    brandOwnerUserId: string;
    dto: SendMessageDto;
    idempotencyKey?: string;
  }) {
    if (!params.idempotencyKey || !params.idempotencyKey.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const bodyText = (params.dto.bodyText ?? '').trim();
    const attachments = await this.attachments.resolveValidatedAttachments(
      params.actorId,
      params.dto.attachmentFileIds,
    );
    if (!bodyText && attachments.length === 0) {
      throw new BadRequestException('bodyText is required when no attachments are provided');
    }

    this.policy.assertCanSend(params.threadStatus);

    const result = await this.prisma.$transaction(async (tx) => {
      const effectiveStatus = await this.resolveCurrentThreadStatusInTx(
        tx,
        params.contextType,
        params.contextId,
      );
      this.policy.assertCanSend(effectiveStatus);

      const thread = await this.getOrCreateThreadInTx(
        tx,
        params.contextType,
        params.contextId,
        params.brandId,
        params.buyerId,
        params.brandOwnerUserId,
        effectiveStatus,
      );

      if (thread.status !== MessageThreadStatus.OPEN) {
        throw new ForbiddenException('Thread is read-only');
      }

      const existing = await tx.message.findFirst({
        where: {
          threadId: thread.id,
          senderUserId: params.actorId,
          clientMessageId: params.dto.clientMessageId,
        },
        include: {
          attachments: {
            include: {
              file: {
                select: {
                  id: true,
                  s3Url: true,
                  originalName: true,
                  mimeType: true,
                  size: true,
                },
              },
            },
          },
          sender: {
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
      if (existing) {
        return { thread, message: existing, replay: true };
      }

      const message = await tx.message.create({
        data: {
          threadId: thread.id,
          senderUserId: params.actorId,
          senderRole: params.actorRole,
          kind: MessageKind.USER,
          clientMessageId: params.dto.clientMessageId,
          bodyText: bodyText || null,
          attachments: {
            create: attachments,
          },
        },
        include: {
          attachments: {
            include: {
              file: {
                select: {
                  id: true,
                  s3Url: true,
                  originalName: true,
                  mimeType: true,
                  size: true,
                },
              },
            },
          },
          sender: {
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

      await tx.messageThread.update({
        where: { id: thread.id },
        data: {
          status: effectiveStatus,
          lastMessageId: message.id,
          lastMessageAt: message.createdAt,
          lastVisibleMessageAt: message.createdAt,
          lastMessagePreview: bodyText ? bodyText.slice(0, 200) : '[Attachment]',
          lastSenderUserId: params.actorId,
        },
      });

      await tx.messageThreadParticipant.upsert({
        where: { threadId_userId: { threadId: thread.id, userId: params.actorId } },
        update: {
          role: params.actorRole,
          lastReadMessageId: message.id,
          lastReadAt: message.createdAt,
        },
        create: {
          threadId: thread.id,
          userId: params.actorId,
          role: params.actorRole,
          lastReadMessageId: message.id,
          lastReadAt: message.createdAt,
        },
      });

      const recipients = [
        params.buyerId
          ? {
              id: params.buyerId,
              role: 'BUYER' as const,
            }
          : null,
        {
          id: params.brandOwnerUserId,
          role: 'BRAND_OWNER' as const,
        },
      ]
        .filter((entry): entry is { id: string; role: 'BUYER' | 'BRAND_OWNER' } => Boolean(entry))
        .filter((entry) => entry.id !== params.actorId);

      if (recipients.length > 0) {
        await tx.messageNotificationOutbox.createMany({
          data: recipients.map((recipient) => ({
            threadId: thread.id,
            messageId: message.id,
            recipientId: recipient.id,
            notificationType: NotificationType.MESSAGE_RECEIVED,
            payloadJson: {
              threadId: thread.id,
              messageId: message.id,
              contextType: thread.contextType,
              orderId: thread.orderId,
              customOrderId: thread.customOrderId,
              targetUrl: this.resolveThreadTargetUrl(
                thread.contextType,
                thread.orderId,
                thread.customOrderId,
                thread.brandId,
                recipient.role,
              ),
            } as Prisma.InputJsonValue,
          })),
        });
      }

      return { thread, message, replay: false };
    });

    const recipientIds = [params.buyerId, params.brandOwnerUserId]
      .filter((id): id is string => Boolean(id));

    if (!result.replay) {
      await this.sideEffects.dispatchMessageOutboxForMessage(result.message.id);
      this.sideEffects.emitMessageCreated(result.thread, recipientIds, {
        id: result.message.id,
        senderRole: result.message.senderRole,
        createdAt: result.message.createdAt,
      });
      this.sideEffects.emitThreadInvalidation(result.thread, recipientIds);
    }

    return {
      statusCode: result.replay ? 200 : 201,
      replay: result.replay,
      thread: result.thread,
      message: result.message,
    };
  }

  private async getOrCreateThreadForCustomOrder(
    context: { customOrderId: string; brandId: string; buyerId: string; brandOwnerUserId: string; status: CustomOrderStatus },
    createWhenMissing: boolean,
  ) {
    const existing = await this.getThreadByContext(MessageContextType.CUSTOM_ORDER, context.customOrderId);
    if (existing || !createWhenMissing) return existing;

    const status = this.policy.resolveThreadStatusForCustomOrder(context.status);
    if (context.status === CustomOrderStatus.DRAFT || context.status === CustomOrderStatus.PENDING_PAYMENT) {
      return null;
    }

    return this.prisma.messageThread.create({
      data: {
        contextType: MessageContextType.CUSTOM_ORDER,
        customOrderId: context.customOrderId,
        brandId: context.brandId,
        buyerId: context.buyerId,
        status,
        participants: {
          create: [
            { userId: context.buyerId, role: MessageParticipantRole.BUYER },
            { userId: context.brandOwnerUserId, role: MessageParticipantRole.BRAND_OWNER },
          ],
        },
      },
      include: { participants: true },
    });
  }

  private async getOrCreateThreadForOrder(
    context: { orderId: string; brandId: string; buyerId: string | null; brandOwnerUserId: string; status: OrderStatus },
    createWhenMissing: boolean,
  ) {
    const existing = await this.getThreadByContext(MessageContextType.STANDARD_ORDER, context.orderId);
    if (existing || !createWhenMissing) return existing;

    const status = this.policy.resolveThreadStatusForOrder(context.status);
    return this.prisma.messageThread.create({
      data: {
        contextType: MessageContextType.STANDARD_ORDER,
        orderId: context.orderId,
        brandId: context.brandId,
        buyerId: context.buyerId,
        status,
        participants: {
          create: [
            ...(context.buyerId ? [{ userId: context.buyerId, role: MessageParticipantRole.BUYER }] : []),
            { userId: context.brandOwnerUserId, role: MessageParticipantRole.BRAND_OWNER },
          ],
        },
      },
      include: { participants: true },
    });
  }

  private async getOrCreateThreadInTx(
    tx: Prisma.TransactionClient,
    contextType: MessageContextType,
    contextId: string,
    brandId: string,
    buyerId: string | null,
    brandOwnerUserId: string,
    status: MessageThreadStatus,
  ) {
    const where = this.policy.buildContextFilter(contextType, contextId);
    const existing = await tx.messageThread.findFirst({ where, include: { participants: true } });
    if (existing) {
      return existing;
    }

    return tx.messageThread.create({
      data: {
        contextType,
        ...(contextType === MessageContextType.CUSTOM_ORDER ? { customOrderId: contextId } : { orderId: contextId }),
        brandId,
        buyerId,
        status,
        participants: {
          create: [
            ...(buyerId ? [{ userId: buyerId, role: MessageParticipantRole.BUYER }] : []),
            { userId: brandOwnerUserId, role: MessageParticipantRole.BRAND_OWNER },
          ],
        },
      },
      include: { participants: true },
    });
  }

  private async getThreadByContext(contextType: MessageContextType, contextId: string) {
    return this.prisma.messageThread.findFirst({
      where: this.policy.buildContextFilter(contextType, contextId),
      include: { participants: true },
    });
  }

  private async getThreadOrThrow(threadId: string) {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: { participants: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  private async resolveCustomOrderContext(
    customOrderId: string,
    actorId: string,
    role: 'BUYER' | 'BRAND_OWNER',
    brandId?: string,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: {
        id: true,
        status: true,
        brandId: true,
        buyerId: true,
        brand: { select: { ownerId: true } },
      },
    });
    if (!order) throw new NotFoundException('Custom order not found');

    if (role === 'BUYER') {
      if (order.buyerId !== actorId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
    } else {
      if (brandId && order.brandId !== brandId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
      if (order.brand.ownerId !== actorId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
    }

    return {
      customOrderId: order.id,
      status: order.status,
      brandId: order.brandId,
      buyerId: order.buyerId,
      brandOwnerUserId: order.brand.ownerId,
    };
  }

  private async resolveStandardOrderContext(
    orderId: string,
    actorId: string,
    role: 'BUYER' | 'BRAND_OWNER',
    brandId?: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        brandId: true,
        buyerId: true,
        brand: { select: { ownerId: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (role === 'BUYER') {
      if (!order.buyerId || order.buyerId !== actorId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
    } else {
      if (brandId && order.brandId !== brandId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
      if (order.brand.ownerId !== actorId) {
        throw new ForbiddenException('Not allowed to access this thread');
      }
    }

    return {
      orderId: order.id,
      status: order.status,
      brandId: order.brandId,
      buyerId: order.buyerId,
      brandOwnerUserId: order.brand.ownerId,
    };
  }

  private async resolveCurrentThreadStatusInTx(
    tx: Prisma.TransactionClient,
    contextType: MessageContextType,
    contextId: string,
  ) {
    if (contextType === MessageContextType.CUSTOM_ORDER) {
      const customOrder = await tx.customOrder.findUnique({
        where: { id: contextId },
        select: { status: true },
      });
      if (!customOrder) {
        throw new NotFoundException('Custom order not found');
      }

      return this.policy.resolveThreadStatusForCustomOrder(customOrder.status);
    }

    const order = await tx.order.findUnique({
      where: { id: contextId },
      select: { status: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return this.policy.resolveThreadStatusForOrder(order.status);
  }

  private async notifyModeration(thread: { id: string; contextType: MessageContextType; orderId: string | null; customOrderId: string | null; brandId: string | null }, messageId: string, adminId: string, reason?: string) {
    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId: thread.id },
      select: { userId: true, role: true },
    });

    if (participants.length === 0) return;

    await this.prisma.messageNotificationOutbox.createMany({
      data: participants.map((p) => ({
        threadId: thread.id,
        messageId,
        recipientId: p.userId,
        notificationType: NotificationType.MESSAGE_MODERATED,
        payloadJson: {
          threadId: thread.id,
          messageId,
          reason: reason ?? null,
          contextType: thread.contextType,
          orderId: thread.orderId,
          customOrderId: thread.customOrderId,
          moderatedBy: adminId,
          targetUrl: this.resolveThreadTargetUrl(
            thread.contextType,
            thread.orderId,
            thread.customOrderId,
            thread.brandId,
            p.role,
          ),
        } as Prisma.InputJsonValue,
      })),
    });

    await this.sideEffects.dispatchMessageOutboxForMessage(messageId);
    this.sideEffects.emitThreadInvalidation(thread as any, participants.map((p) => p.userId));
  }

  private resolveThreadTargetUrl(
    contextType: MessageContextType,
    orderId: string | null,
    customOrderId: string | null,
    brandId: string | null,
    recipientRole: MessageParticipantRole,
  ): string {
    if (contextType === MessageContextType.CUSTOM_ORDER && customOrderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER) {
        return `/studio/custom-orders/${customOrderId}#messages`;
      }
      if (recipientRole === MessageParticipantRole.ADMIN) {
        return `/admin/custom-orders/${customOrderId}#messages`;
      }
      return `/custom-orders/${customOrderId}#messages`;
    }

    if (contextType === MessageContextType.STANDARD_ORDER && orderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER && brandId) {
        return `/brands/${brandId}/orders/${orderId}#messages`;
      }
      return `/orders/access/${orderId}#messages`;
    }

    return '/settings?tab=notifications';
  }
}
