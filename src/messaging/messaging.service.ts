import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminDisputeStatus,
  AdminAuditAction,
  CustomOrderStatus,
  DisputeType,
  MessageContextType,
  MessageKind,
  MessageParticipantRole,
  MessageThreadStatus,
  NotificationType,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { CustomOrdersService } from 'src/custom-orders/custom-orders.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateCustomOrderExtensionRequestDto,
  ReportCustomOrderIssueDto,
  RespondToCustomOrderExtensionDto,
} from 'src/custom-orders/dto/custom-orders.dto';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';
import {
  AdminSystemMessageDto,
  BulkQueryThreadSummaryDto,
  MarkThreadReadDto,
  OpenCustomOrderDisputeDto,
  OpenOrderDisputeDto,
  QueryInboxDto,
  QueryMessagesDto,
  QueryThreadSummaryDto,
  RequestCustomOrderExtensionDto,
  RequestOrderExtensionDto,
  RespondCustomOrderExtensionDto,
  RespondOrderExtensionDto,
  SendMessageDto,
  UpdateThreadPreferencesDto,
} from './dto/messaging.dto';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminAudit: AdminAuditService,
    private readonly attachments: MessagingAttachmentService,
    private readonly policy: MessagingPolicyService,
    private readonly query: MessagingQueryService,
    private readonly sideEffects: MessagingSideEffectsService,
    private readonly customOrdersService: CustomOrdersService,
  ) {}

  async listCustomOrderMessagesForBuyer(actorId: string, customOrderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BUYER');
    const thread = await this.getOrCreateThreadForCustomOrder(resolved, false);
    if (!thread) return { items: [], hasNextPage: false, endCursor: null, thread: null };
    const result = await this.query.getMessages(thread.id, { ...queryDto, actorId }, { includeModerated: false });
    await this.acknowledgeDeliveryForActor(thread.id, actorId, result.items);
    return { ...result, thread };
  }

  async listCustomOrderMessagesForBrand(actorId: string, brandId: string, customOrderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BRAND_OWNER', brandId);
    const thread = await this.getOrCreateThreadForCustomOrder(resolved, false);
    if (!thread) return { items: [], hasNextPage: false, endCursor: null, thread: null };
    const result = await this.query.getMessages(thread.id, { ...queryDto, actorId }, { includeModerated: false });
    await this.acknowledgeDeliveryForActor(thread.id, actorId, result.items);
    return { ...result, thread };
  }

  async listOrderMessagesForBuyer(actorId: string, orderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BUYER');
    const thread = await this.getOrCreateThreadForOrder(resolved, true);
    const result = await this.query.getMessages(thread.id, { ...queryDto, actorId }, { includeModerated: false });
    await this.acknowledgeDeliveryForActor(thread.id, actorId, result.items);
    return { ...result, thread };
  }

  async listOrderMessagesForBrand(actorId: string, brandId: string, orderId: string, queryDto: QueryMessagesDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BRAND_OWNER', brandId);
    const thread = await this.getOrCreateThreadForOrder(resolved, true);
    const result = await this.query.getMessages(thread.id, { ...queryDto, actorId }, { includeModerated: false });
    await this.acknowledgeDeliveryForActor(thread.id, actorId, result.items);
    return { ...result, thread };
  }

  async listThreadMessagesForActor(actorId: string, threadId: string, queryDto: QueryMessagesDto) {
    const thread = await this.prisma.messageThread.findFirst({
      where: {
        id: threadId,
        participants: { some: { userId: actorId } },
      },
      include: { participants: true },
    });
    if (!thread) {
      throw new ForbiddenException('Thread access denied');
    }

    const result = await this.query.getMessages(thread.id, { ...queryDto, actorId }, { includeModerated: false });
    await this.acknowledgeDeliveryForActor(thread.id, actorId, result.items);
    return { ...result, thread };
  }

  /** When a user fetches messages, automatically acknowledge delivery for messages from others */
  private async acknowledgeDeliveryForActor(
    threadId: string,
    actorId: string,
    items: Array<{ id: string; senderUserId?: string | null }>,
  ): Promise<void> {
    const undeliveredFromOthers = items
      .filter((m) => m.senderUserId && m.senderUserId !== actorId)
      .map((m) => m.id);
    if (undeliveredFromOthers.length > 0) {
      await this.query.acknowledgeDelivery(threadId, actorId, undeliveredFromOthers).catch(() => {});
      // Emit delivery event to all participants so senders update their ticks
      const thread = await this.query.getThreadById(threadId);
      if (thread) {
        const allIds = thread.participants.map((p) => p.userId);
        this.sideEffects.emitThreadInvalidation(thread, allIds);
      }
    }
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

  async sendMessageToThread(actorId: string, threadId: string, dto: SendMessageDto, idempotencyKey?: string) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const thread = await this.prisma.messageThread.findFirst({
      where: {
        id: threadId,
        participants: { some: { userId: actorId } },
      },
      include: { participants: true },
    });
    if (!thread) {
      throw new ForbiddenException('Thread access denied');
    }

    this.policy.assertCanSend(thread.status);
    const actorParticipant = thread.participants.find((participant) => participant.userId === actorId);
    if (!actorParticipant) {
      throw new ForbiddenException('Thread access denied');
    }

    const bodyText = (dto.bodyText ?? '').trim();
    const attachments = await this.attachments.resolveValidatedAttachments(
      actorId,
      dto.attachmentFileIds,
    );
    if (!bodyText && attachments.length === 0) {
      throw new BadRequestException('bodyText is required when no attachments are provided');
    }

    const existing = await this.prisma.message.findFirst({
      where: {
        threadId: thread.id,
        senderUserId: actorId,
        clientMessageId: dto.clientMessageId,
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
      return {
        statusCode: 200,
        replay: true,
        thread,
        message: existing,
      };
    }

    const message = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: actorId,
        senderRole: actorParticipant.role,
        kind: MessageKind.USER,
        clientMessageId: dto.clientMessageId,
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

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastVisibleMessageAt: message.createdAt,
        lastMessagePreview: bodyText ? bodyText.slice(0, 200) : '[Attachment]',
        lastSenderUserId: actorId,
      },
    });

    await this.prisma.messageThreadParticipant.upsert({
      where: { threadId_userId: { threadId: thread.id, userId: actorId } },
      update: {
        role: actorParticipant.role,
        lastReadMessageId: message.id,
        lastReadAt: message.createdAt,
      },
      create: {
        threadId: thread.id,
        userId: actorId,
        role: actorParticipant.role,
        lastReadMessageId: message.id,
        lastReadAt: message.createdAt,
      },
    });

    const recipients = thread.participants
      .filter((entry) => entry.userId !== actorId)
      .map((entry) => ({ id: entry.userId, role: entry.role }));

    if (recipients.length > 0) {
      const senderDisplayName =
        message.sender?.firstName ||
        message.sender?.username ||
        (actorParticipant.role === 'BRAND_OWNER' ? 'Brand' : 'User');

      await this.prisma.messageNotificationOutbox.createMany({
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
            actorUserId: actorId,
            message: `${senderDisplayName} sent a new message`,
            targetUrl: this.resolveThreadTargetUrl(
              thread.contextType,
              thread.orderId,
              thread.customOrderId,
              thread.brandId,
              recipient.role,
              thread.id,
              message.id,
            ),
          } as Prisma.InputJsonValue,
        })),
      });
    }

    const recipientIds = thread.participants.map((entry) => entry.userId);
    await this.sideEffects.dispatchMessageOutboxForMessage(message.id);
    this.sideEffects.emitMessageCreated(thread, recipientIds, {
      id: message.id,
      senderRole: message.senderRole,
      createdAt: message.createdAt,
    });
    this.sideEffects.emitThreadInvalidation(thread, recipientIds);

    return {
      statusCode: 201,
      replay: false,
      thread,
      message,
    };
  }

  async requestOrderExtensionForBrand(actorId: string, brandId: string, orderId: string, dto: RequestOrderExtensionDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BRAND_OWNER', brandId);
    if (!resolved.buyerId) {
      throw new BadRequestException('Order has no linked buyer account for message-based extension requests');
    }

    const existingThread = await this.getThreadByContext(MessageContextType.STANDARD_ORDER, orderId);
    if (existingThread) {
      const existingRequests = await this.prisma.message.findMany({
        where: {
          threadId: existingThread.id,
          senderRole: MessageParticipantRole.SYSTEM,
        },
        select: { metadataJson: true },
      });

      const alreadyRequested = existingRequests.some((entry) => {
        const metadata = (entry.metadataJson as Record<string, unknown> | null) ?? null;
        return String(metadata?.eventType || '') === 'STANDARD_ORDER_EXTENSION_REQUESTED';
      });
      if (alreadyRequested) {
        throw new BadRequestException('Brand can only request one extension per order');
      }
    }


    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.STANDARD_ORDER,
      contextId: orderId,
      actorId,
      actorRole: MessageParticipantRole.BRAND_OWNER,
      threadStatus: this.policy.resolveThreadStatusForOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Brand requested an extension of ${dto.requestedExtraDays} day(s).`,
      metadata: {
        eventType: 'STANDARD_ORDER_EXTENSION_REQUESTED',
        requestedExtraDays: dto.requestedExtraDays,
        reason: dto.reason.trim(),
      },
      origin: 'BRAND',
    });

    return {
      statusCode: 201,
      message: 'Order extension request posted to thread',
      requestMessageId: message.id,
    };
  }

  async getInboxForActor(actorId: string, queryDto: QueryInboxDto) {
    const limit = Math.min(Math.max(queryDto.limit ?? 20, 1), 100);
    const filter = queryDto.filter ?? 'all';
    const contextTypeFilter = queryDto.contextType ?? 'all';
    const q = String(queryDto.q ?? '').trim();
    const cursorDate = queryDto.cursorLastMessageAt ? new Date(queryDto.cursorLastMessageAt) : null;

    const threadWhere: Prisma.MessageThreadWhereInput = {
      participants: {
        some: {
          userId: actorId,
          ...(filter === 'archived'
            ? { archivedAt: { not: null } }
            : { archivedAt: null }),
        },
      },
      ...(contextTypeFilter !== 'all' ? { contextType: contextTypeFilter as MessageContextType } : {}),
      ...(q
        ? {
            OR: [
              { lastMessagePreview: { contains: q, mode: 'insensitive' } },
              {
                messages: {
                  some: {
                    bodyText: { contains: q, mode: 'insensitive' },
                  },
                },
              },
              {
                participants: {
                  some: {
                    user: {
                      OR: [
                        { username: { contains: q, mode: 'insensitive' } },
                        { firstName: { contains: q, mode: 'insensitive' } },
                        { lastName: { contains: q, mode: 'insensitive' } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(cursorDate
        ? {
            OR: [
              { lastMessageAt: { lt: cursorDate } },
              {
                AND: [
                  { lastMessageAt: cursorDate },
                  { id: { lt: queryDto.cursorThreadId ?? '' } },
                ],
              },
            ],
          }
        : {}),
    };

    const threads = await this.prisma.messageThread.findMany({
      where: threadWhere,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        participants: {
          select: {
            userId: true,
            role: true,
            mutedUntil: true,
            archivedAt: true,
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

    const hasNextPage = threads.length > limit;
    const sliced = hasNextPage ? threads.slice(0, -1) : threads;
    const threadIds = sliced.map((thread) => thread.id);
    const summaries = threadIds.length > 0
      ? await this.query.getSummariesForActor(threadIds, actorId, true)
      : {};

    const meRole = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId: { in: threadIds }, userId: actorId },
      select: { threadId: true, role: true },
    });
    const roleByThread = new Map(meRole.map((r) => [r.threadId, r.role]));

    const items = sliced
      .map((thread) => {
        const summary = summaries[thread.id];
        const counterpart = thread.participants.find((p) => p.userId !== actorId);
        const actorRole = roleByThread.get(thread.id) ?? counterpart?.role ?? MessageParticipantRole.BUYER;

        const isInquiry =
          thread.contextType === MessageContextType.CUSTOM_ORDER &&
          !thread.customOrderId &&
          !thread.orderId &&
          String((thread.subjectSnapshotJson as any)?.type || '').toUpperCase() === 'CUSTOM_FIT_INQUIRY';

        const targetUrl = this.resolveThreadTargetUrl(
          thread.contextType,
          thread.orderId,
          thread.customOrderId,
          thread.brandId,
          actorRole,
          thread.id,
          null,
        );

        return {
          threadId: thread.id,
          contextType: isInquiry ? 'INQUIRY' : thread.contextType,
          orderId: thread.orderId,
          customOrderId: thread.customOrderId,
          inquiryId: isInquiry ? (thread.subjectSnapshotJson as any)?.inquiryId ?? null : null,
          title:
            isInquiry
              ? `Inquiry #${String((thread.subjectSnapshotJson as any)?.inquiryId || thread.id).slice(0, 8).toUpperCase()}`
              : thread.contextType === MessageContextType.STANDARD_ORDER
                ? `Order #${String(thread.orderId || thread.id).slice(0, 8).toUpperCase()}`
                : `Custom #${String(thread.customOrderId || thread.id).slice(0, 8).toUpperCase()}`,
          subtitle: thread.lastMessagePreview || 'No messages yet',
          participant: counterpart?.user
            ? {
                id: counterpart.user.id,
                username: counterpart.user.username,
                firstName: counterpart.user.firstName,
                lastName: counterpart.user.lastName,
                profileImage: counterpart.user.profileImage,
              }
            : null,
          lastMessageAt: thread.lastMessageAt,
          createdAt: thread.createdAt,
          unreadCount: Number(summary?.unreadCount ?? 0),
          hasUnread: Boolean(summary?.hasUnread),
          mutedUntil: summary?.mutedUntil ?? null,
          archivedAt: summary?.archivedAt ?? null,
          targetUrl,
        };
      })
      .filter((item) => (filter === 'unread' ? item.hasUnread || item.unreadCount > 0 : true));

    const endCursor =
      items.length > 0
        ? {
            cursorLastMessageAt: items[items.length - 1].lastMessageAt || items[items.length - 1].createdAt,
            cursorThreadId: items[items.length - 1].threadId,
          }
        : null;

    return {
      items,
      hasNextPage,
      endCursor,
    };
  }

  async resolveThreadForActor(actorId: string, threadId: string) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actorId } },
      include: {
        thread: {
          select: {
            id: true,
            contextType: true,
            orderId: true,
            customOrderId: true,
            brandId: true,
            subjectSnapshotJson: true,
          },
        },
      },
    });

    if (!participant) {
      throw new ForbiddenException('Thread access denied');
    }

    const thread = participant.thread;
    const targetUrl = this.resolveThreadTargetUrl(
      thread.contextType,
      thread.orderId,
      thread.customOrderId,
      thread.brandId,
      participant.role,
      thread.id,
      null,
    );

    return {
      threadId: thread.id,
      contextType: thread.contextType,
      orderId: thread.orderId,
      customOrderId: thread.customOrderId,
      inquiryType: String((thread.subjectSnapshotJson as any)?.type || ''),
      targetUrl,
    };
  }

  async markThreadReadById(actorId: string, threadId: string, dto: MarkThreadReadDto) {
    const participant = await this.prisma.messageThreadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: actorId } },
      include: {
        thread: {
          include: { participants: true },
        },
      },
    });

    if (!participant) {
      throw new ForbiddenException('Thread access denied');
    }

    const upToMessage = dto.upToMessageId
      ? await this.prisma.message.findFirst({
          where: { id: dto.upToMessageId, threadId },
          select: { id: true, createdAt: true },
        })
      : await this.prisma.message.findFirst({
          where: { threadId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, createdAt: true },
        });

    await this.prisma.messageThreadParticipant.update({
      where: { threadId_userId: { threadId, userId: actorId } },
      data: {
        lastReadMessageId: upToMessage?.id ?? null,
        lastReadAt: upToMessage?.createdAt ?? new Date(),
      },
    });

    // Create read receipts for all messages up to this point
    if (upToMessage) {
      await this.query.markMessagesRead(threadId, actorId, upToMessage.id);
    }

    // Emit read event to ALL participants so senders can update their tick status
    const allParticipantIds = participant.thread.participants.map((p) => p.userId);
    this.sideEffects.emitThreadInvalidation(participant.thread, allParticipantIds);
    this.sideEffects.emitMessageRead(participant.thread as any, actorId, upToMessage?.id ?? null, allParticipantIds);

    return {
      success: true,
      threadId,
      lastReadMessageId: upToMessage?.id ?? null,
    };
  }

  async respondToOrderExtensionForBuyer(
    actorId: string,
    orderId: string,
    requestMessageId: string,
    dto: RespondOrderExtensionDto,
  ) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BUYER');
    if (dto.response === 'COUNTERED' && !dto.counterDays) {
      throw new BadRequestException('Counter response requires counterDays');
    }

    const thread = await this.getThreadByContext(MessageContextType.STANDARD_ORDER, orderId);
    if (!thread) {
      throw new NotFoundException('Message thread not found for this order');
    }

    const requestMessage = await this.prisma.message.findFirst({
      where: {
        id: requestMessageId,
        threadId: thread.id,
        kind: MessageKind.SYSTEM,
      },
      select: { id: true, metadataJson: true },
    });
    if (!requestMessage) {
      throw new NotFoundException('Extension request reference was not found in this order thread');
    }

    const metadata = (requestMessage.metadataJson as Record<string, unknown> | null) ?? {};
    if (String(metadata.eventType || '') !== 'STANDARD_ORDER_EXTENSION_REQUESTED') {
      throw new BadRequestException('Referenced message is not an order extension request');
    }

    const responseLabel = dto.response === 'COUNTERED'
      ? `countered with ${dto.counterDays} day(s)`
      : dto.response.toLowerCase();

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.STANDARD_ORDER,
      contextId: orderId,
      actorId,
      actorRole: MessageParticipantRole.BUYER,
      threadStatus: this.policy.resolveThreadStatusForOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Buyer ${responseLabel} the extension request.`,
      metadata: {
        eventType: 'STANDARD_ORDER_EXTENSION_RESPONDED',
        response: dto.response,
        counterDays: dto.counterDays ?? null,
        note: dto.note?.trim() || null,
        requestMessageId,
      },
      origin: 'BUYER',
    });

    return {
      statusCode: 200,
      message: 'Order extension response posted to thread',
      messageId: message.id,
    };
  }

  async openOrderDisputeForBuyer(actorId: string, orderId: string, dto: OpenOrderDisputeDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BUYER');
    return this.openStandardOrderDispute(
      actorId,
      resolved,
      dto.description,
      MessageParticipantRole.BUYER,
      'BUYER',
    );
  }

  async openOrderDisputeForBrand(actorId: string, brandId: string, orderId: string, dto: OpenOrderDisputeDto) {
    const resolved = await this.resolveStandardOrderContext(orderId, actorId, 'BRAND_OWNER', brandId);
    return this.openStandardOrderDispute(
      actorId,
      resolved,
      dto.description,
      MessageParticipantRole.BRAND_OWNER,
      'BRAND',
    );
  }

  async requestCustomOrderExtensionForBrand(
    actorId: string,
    brandId: string,
    customOrderId: string,
    dto: RequestCustomOrderExtensionDto,
  ) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BRAND_OWNER', brandId);

    const result = await this.customOrdersService.createExtensionRequest(
      actorId,
      brandId,
      customOrderId,
      dto as CreateCustomOrderExtensionRequestDto,
    );

    const requestId =
      (result as any)?.data?.extensionRequests?.[0]?.id ||
      (result as any)?.data?.extensionRequests
        ?.slice()
        ?.sort((a: any, b: any) => +new Date(b?.createdAt || 0) - +new Date(a?.createdAt || 0))?.[0]?.id ||
      null;

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BRAND_OWNER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Brand requested ${dto.requestedExtraDays} extra day(s) for ${dto.targetType.toLowerCase()}.`,
      metadata: {
        eventType: 'CUSTOM_ORDER_EXTENSION_REQUESTED',
        requestId,
        targetType: dto.targetType,
        requestedExtraDays: dto.requestedExtraDays,
        reason: dto.reason.trim(),
      },
      origin: 'BRAND',
    });

    return {
      ...result,
      messageThreadEventId: message.id,
      extensionRequestId: requestId,
    };
  }

  async respondToCustomOrderExtensionForBuyer(
    actorId: string,
    customOrderId: string,
    requestId: string,
    dto: RespondCustomOrderExtensionDto,
  ) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BUYER');

    const result = await this.customOrdersService.respondToExtension(
      actorId,
      customOrderId,
      requestId,
      dto as RespondToCustomOrderExtensionDto,
    );

    const responseLabel = dto.response === 'COUNTERED'
      ? `countered with ${dto.counterDays} day(s)`
      : dto.response.toLowerCase();

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BUYER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Buyer ${responseLabel} the extension request.`,
      metadata: {
        eventType: 'CUSTOM_ORDER_EXTENSION_RESPONDED',
        requestId,
        response: dto.response,
        counterDays: dto.counterDays ?? null,
      },
      origin: 'BUYER',
    });

    return {
      ...result,
      messageThreadEventId: message.id,
    };
  }

  async openCustomOrderDisputeForBuyer(actorId: string, customOrderId: string, dto: OpenCustomOrderDisputeDto) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BUYER');

    const result = await this.customOrdersService.reportIssue(
      actorId,
      customOrderId,
      dto as ReportCustomOrderIssueDto,
    );

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BUYER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Buyer opened a dispute (${dto.issueType.replaceAll('_', ' ').toLowerCase()}).`,
      metadata: {
        eventType: 'CUSTOM_ORDER_DISPUTE_OPENED',
        issueType: dto.issueType,
        description: dto.description.trim(),
      },
      origin: 'BUYER',
    });

    return {
      ...result,
      messageThreadEventId: message.id,
    };
  }

  async openCustomOrderDisputeForBrand(
    actorId: string,
    brandId: string,
    customOrderId: string,
    dto: OpenCustomOrderDisputeDto,
  ) {
    const resolved = await this.resolveCustomOrderContext(customOrderId, actorId, 'BRAND_OWNER', brandId);

    const dispute = await this.prisma.dispute.create({
      data: {
        id: randomUUID(),
        type: DisputeType.ORDER,
        reporter: { connect: { id: actorId } },
        targetType: 'CUSTOM_ORDER',
        targetId: customOrderId,
        description: dto.description.trim(),
        status: AdminDisputeStatus.OPEN,
      },
      select: { id: true },
    });

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.CUSTOM_ORDER,
      contextId: customOrderId,
      actorId,
      actorRole: MessageParticipantRole.BRAND_OWNER,
      threadStatus: this.policy.resolveThreadStatusForCustomOrder(resolved.status),
      brandId: resolved.brandId,
      buyerId: resolved.buyerId,
      brandOwnerUserId: resolved.brandOwnerUserId,
      bodyText: `Brand opened a dispute (${dto.issueType.replaceAll('_', ' ').toLowerCase()}).`,
      metadata: {
        eventType: 'CUSTOM_ORDER_DISPUTE_OPENED',
        disputeId: dispute.id,
        issueType: dto.issueType,
        description: dto.description.trim(),
      },
      origin: 'BRAND',
    });

    return {
      statusCode: 201,
      message: 'Custom order dispute opened and posted to thread',
      disputeId: dispute.id,
      messageId: message.id,
    };
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

  async updateThreadPreferencesForContext(
    actorId: string,
    contextType: MessageContextType,
    contextId: string,
    role: 'BUYER' | 'BRAND_OWNER',
    dto: UpdateThreadPreferencesDto,
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

    const nextMutedUntil = dto.unmute
      ? null
      : dto.muteForHours
        ? new Date(Date.now() + dto.muteForHours * 60 * 60 * 1000)
        : undefined;
    const nextArchivedAt = dto.archived === undefined ? undefined : dto.archived ? new Date() : null;

    const upToMessage = dto.markRead
      ? await this.prisma.message.findFirst({
          where: { threadId: thread.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, createdAt: true },
        })
      : null;

    const participant = await this.prisma.messageThreadParticipant.upsert({
      where: { threadId_userId: { threadId: thread.id, userId: actorId } },
      update: {
        role,
        ...(nextMutedUntil !== undefined ? { mutedUntil: nextMutedUntil } : {}),
        ...(nextArchivedAt !== undefined ? { archivedAt: nextArchivedAt } : {}),
        ...(upToMessage
          ? {
              lastReadMessageId: upToMessage.id,
              lastReadAt: upToMessage.createdAt,
            }
          : {}),
      },
      create: {
        threadId: thread.id,
        userId: actorId,
        role,
        mutedUntil: nextMutedUntil ?? null,
        archivedAt: nextArchivedAt ?? null,
        lastReadMessageId: upToMessage?.id ?? null,
        lastReadAt: upToMessage?.createdAt ?? new Date(),
      },
      select: {
        mutedUntil: true,
        archivedAt: true,
        lastReadMessageId: true,
      },
    });

    this.sideEffects.emitThreadInvalidation(thread, [actorId]);
    if (upToMessage) {
      this.sideEffects.emitMessageRead(thread as any, actorId, upToMessage.id);
    }

    return {
      success: true,
      threadId: thread.id,
      mutedUntil: participant.mutedUntil,
      archivedAt: participant.archivedAt,
      lastReadMessageId: participant.lastReadMessageId,
    };
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

  async getBulkSummariesForCustomOrdersBuyer(actorId: string, queryDto: BulkQueryThreadSummaryDto) {
    const contextIds = this.normalizeContextIds(queryDto.contextIds);
    const allowed = await this.prisma.customOrder.findMany({
      where: {
        id: { in: contextIds },
        buyerId: actorId,
      },
      select: { id: true },
    });

    return this.getBulkSummariesForContext(
      actorId,
      MessageContextType.CUSTOM_ORDER,
      contextIds,
      allowed.map((entry) => entry.id),
      queryDto.includeUnreadCount === 'true',
    );
  }

  async getBulkSummariesForCustomOrdersBrand(
    actorId: string,
    brandId: string,
    queryDto: BulkQueryThreadSummaryDto,
  ) {
    const contextIds = this.normalizeContextIds(queryDto.contextIds);
    const allowed = await this.prisma.customOrder.findMany({
      where: {
        id: { in: contextIds },
        brand: {
          ownerId: actorId,
          OR: [{ id: brandId }, { ownerId: brandId }],
        },
      },
      select: { id: true },
    });

    return this.getBulkSummariesForContext(
      actorId,
      MessageContextType.CUSTOM_ORDER,
      contextIds,
      allowed.map((entry) => entry.id),
      queryDto.includeUnreadCount === 'true',
    );
  }

  async getBulkSummariesForOrdersBuyer(actorId: string, queryDto: BulkQueryThreadSummaryDto) {
    const contextIds = this.normalizeContextIds(queryDto.contextIds);
    const allowed = await this.prisma.order.findMany({
      where: {
        id: { in: contextIds },
        buyerId: actorId,
      },
      select: { id: true },
    });

    return this.getBulkSummariesForContext(
      actorId,
      MessageContextType.STANDARD_ORDER,
      contextIds,
      allowed.map((entry) => entry.id),
      queryDto.includeUnreadCount === 'true',
    );
  }

  async getBulkSummariesForOrdersBrand(
    actorId: string,
    brandId: string,
    queryDto: BulkQueryThreadSummaryDto,
  ) {
    const contextIds = this.normalizeContextIds(queryDto.contextIds);
    const allowed = await this.prisma.order.findMany({
      where: {
        id: { in: contextIds },
        brand: {
          ownerId: actorId,
          OR: [{ id: brandId }, { ownerId: brandId }],
        },
      },
      select: { id: true },
    });

    return this.getBulkSummariesForContext(
      actorId,
      MessageContextType.STANDARD_ORDER,
      contextIds,
      allowed.map((entry) => entry.id),
      queryDto.includeUnreadCount === 'true',
    );
  }

  async getAdminInbox(queryDto: QueryInboxDto) {
    const limit = Math.min(Math.max(queryDto.limit ?? 20, 1), 100);
    const filter = queryDto.filter ?? 'all';
    const contextTypeFilter = queryDto.contextType ?? 'all';
    const q = String(queryDto.q ?? '').trim();
    const cursorDate = queryDto.cursorLastMessageAt ? new Date(queryDto.cursorLastMessageAt) : null;

    const threadWhere: Prisma.MessageThreadWhereInput = {
      ...(contextTypeFilter !== 'all' ? { contextType: contextTypeFilter as MessageContextType } : {}),
      ...(filter === 'archived' ? { status: MessageThreadStatus.ARCHIVED } : {}),
      ...(q
        ? {
            OR: [
              { lastMessagePreview: { contains: q, mode: 'insensitive' as const } },
              {
                participants: {
                  some: {
                    user: {
                      OR: [
                        { username: { contains: q, mode: 'insensitive' as const } },
                        { firstName: { contains: q, mode: 'insensitive' as const } },
                        { lastName: { contains: q, mode: 'insensitive' as const } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(cursorDate
        ? {
            OR: [
              { lastMessageAt: { lt: cursorDate } },
              {
                AND: [
                  { lastMessageAt: cursorDate },
                  { id: { lt: queryDto.cursorThreadId ?? '' } },
                ],
              },
            ],
          }
        : {}),
    };

    const threads = await this.prisma.messageThread.findMany({
      where: threadWhere,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        participants: {
          select: {
            userId: true,
            role: true,
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

    const hasNextPage = threads.length > limit;
    const sliced = hasNextPage ? threads.slice(0, -1) : threads;

    const items = sliced.map((thread) => {
      const isInquiry =
        thread.contextType === MessageContextType.CUSTOM_ORDER &&
        !thread.customOrderId &&
        !thread.orderId &&
        String((thread.subjectSnapshotJson as any)?.type || '').toUpperCase() === 'CUSTOM_FIT_INQUIRY';

      return {
        threadId: thread.id,
        contextType: isInquiry ? 'INQUIRY' : thread.contextType,
        orderId: thread.orderId,
        customOrderId: thread.customOrderId,
        status: thread.status,
        title:
          isInquiry
            ? `Inquiry #${String((thread.subjectSnapshotJson as any)?.inquiryId || thread.id).slice(0, 8).toUpperCase()}`
            : thread.contextType === MessageContextType.STANDARD_ORDER
              ? `Order #${String(thread.orderId || thread.id).slice(0, 8).toUpperCase()}`
              : `Custom #${String(thread.customOrderId || thread.id).slice(0, 8).toUpperCase()}`,
        subtitle: thread.lastMessagePreview || 'No messages yet',
        participants: thread.participants.map((p) => ({
          id: p.user.id,
          username: p.user.username,
          firstName: p.user.firstName,
          lastName: p.user.lastName,
          profileImage: p.user.profileImage,
          role: p.role,
        })),
        lastMessageAt: thread.lastMessageAt,
        createdAt: thread.createdAt,
      };
    });

    const endCursor =
      items.length > 0
        ? {
            cursorLastMessageAt: items[items.length - 1].lastMessageAt || items[items.length - 1].createdAt,
            cursorThreadId: items[items.length - 1].threadId,
          }
        : null;

    return { items, hasNextPage, endCursor };
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
              thread.id,
              reopenMessage.id,
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

      const now = Date.now();
      const perUserWindowStart = new Date(now - 60 * 1000);
      const perThreadWindowStart = new Date(now - 30 * 1000);

      const [perUserBurstCount, perThreadBurstCount] = await Promise.all([
        tx.message.count({
          where: {
            senderUserId: params.actorId,
            createdAt: { gte: perUserWindowStart },
          },
        }),
        tx.message.count({
          where: {
            threadId: thread.id,
            senderUserId: params.actorId,
            createdAt: { gte: perThreadWindowStart },
          },
        }),
      ]);

      if (perUserBurstCount >= 30) {
        throw new HttpException(
          'Too many messages sent in a short time window',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (perThreadBurstCount >= 12) {
        throw new HttpException(
          'Too many messages sent to this thread in a short time window',
          HttpStatus.TOO_MANY_REQUESTS,
        );
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
        const senderName =
          message.sender?.firstName ||
          message.sender?.username ||
          (params.actorRole === 'BRAND_OWNER' ? 'Brand' : 'User');

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
              actorUserId: params.actorId,
              message: `${senderName} sent a new message`,
              targetUrl: this.resolveThreadTargetUrl(
                thread.contextType,
                thread.orderId,
                thread.customOrderId,
                thread.brandId,
                recipient.role,
                thread.id,
                message.id,
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

  private normalizeContextIds(contextIds: string[]) {
    const ids = Array.from(new Set((contextIds ?? []).filter(Boolean)));
    if (ids.length === 0) {
      throw new BadRequestException('contextIds must contain at least one id');
    }
    if (ids.length > 100) {
      throw new BadRequestException('contextIds cannot exceed 100 ids');
    }
    return ids;
  }

  private matchesBrandScope(
    providedBrandId: string,
    actualBrandId: string,
    ownerUserId?: string | null,
  ) {
    return (
      providedBrandId === actualBrandId ||
      (ownerUserId != null && providedBrandId === ownerUserId)
    );
  }

  private async getBulkSummariesForContext(
    actorId: string,
    contextType: MessageContextType,
    contextIds: string[],
    allowedContextIds: string[],
    includeUnreadCount: boolean,
  ) {
    const allowedSet = new Set(allowedContextIds);
    const forbiddenIds = contextIds.filter((contextId) => !allowedSet.has(contextId));
    if (forbiddenIds.length > 0) {
      throw new ForbiddenException('Not allowed to access one or more requested threads');
    }

    const threads = await this.prisma.messageThread.findMany({
      where:
        contextType === MessageContextType.CUSTOM_ORDER
          ? { contextType, customOrderId: { in: contextIds } }
          : { contextType, orderId: { in: contextIds } },
      select: {
        id: true,
        customOrderId: true,
        orderId: true,
      },
    });

    const summaryByThreadId = await this.query.getSummariesForActor(
      threads.map((thread) => thread.id),
      actorId,
      includeUnreadCount,
    );

    const threadByContextId = new Map<string, { id: string; customOrderId: string | null; orderId: string | null }>();
    for (const thread of threads) {
      const contextId =
        contextType === MessageContextType.CUSTOM_ORDER
          ? thread.customOrderId
          : thread.orderId;
      if (contextId) {
        threadByContextId.set(contextId, thread);
      }
    }

    return {
      items: contextIds.map((contextId) => {
        const thread = threadByContextId.get(contextId);
        return {
          contextId,
          summary: thread ? (summaryByThreadId[thread.id] ?? null) : null,
        };
      }),
    };
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
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=CUSTOM_ORDER role=BUYER actorId=${actorId} customOrderId=${customOrderId} expectedBuyerId=${order.buyerId}`,
        );
        throw new ForbiddenException('Not allowed to access this thread');
      }
    } else {
      if (
        brandId &&
        !this.matchesBrandScope(brandId, order.brandId, order.brand.ownerId)
      ) {
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=CUSTOM_ORDER role=BRAND_OWNER actorId=${actorId} customOrderId=${customOrderId} providedBrandId=${brandId} expectedBrandId=${order.brandId} expectedOwnerId=${order.brand.ownerId}`,
        );
        throw new ForbiddenException('Not allowed to access this thread');
      }
      if (order.brand.ownerId !== actorId) {
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=CUSTOM_ORDER role=BRAND_OWNER actorId=${actorId} customOrderId=${customOrderId} expectedOwnerId=${order.brand.ownerId}`,
        );
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
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=STANDARD_ORDER role=BUYER actorId=${actorId} orderId=${orderId} expectedBuyerId=${order.buyerId ?? 'none'}`,
        );
        throw new ForbiddenException('Not allowed to access this thread');
      }
    } else {
      if (
        brandId &&
        !this.matchesBrandScope(brandId, order.brandId, order.brand.ownerId)
      ) {
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=STANDARD_ORDER role=BRAND_OWNER actorId=${actorId} orderId=${orderId} providedBrandId=${brandId} expectedBrandId=${order.brandId} expectedOwnerId=${order.brand.ownerId}`,
        );
        throw new ForbiddenException('Not allowed to access this thread');
      }
      if (order.brand.ownerId !== actorId) {
        this.logger.warn(
          `[THREAD_ACCESS_DENIED] type=STANDARD_ORDER role=BRAND_OWNER actorId=${actorId} orderId=${orderId} expectedOwnerId=${order.brand.ownerId}`,
        );
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
            thread.id,
            messageId,
          ),
        } as Prisma.InputJsonValue,
      })),
    });

    await this.sideEffects.dispatchMessageOutboxForMessage(messageId);
    this.sideEffects.emitThreadInvalidation(thread as any, participants.map((p) => p.userId));
  }

  private async openStandardOrderDispute(
    actorId: string,
    context: {
      orderId: string;
      status: OrderStatus;
      brandId: string;
      buyerId: string | null;
      brandOwnerUserId: string;
    },
    description: string,
    actorRole: 'BUYER' | 'BRAND_OWNER',
    origin: 'BUYER' | 'BRAND',
  ) {
    const existingOpen = await this.prisma.dispute.findFirst({
      where: {
        type: DisputeType.ORDER,
        targetType: 'ORDER',
        targetId: context.orderId,
        status: {
          in: [
            AdminDisputeStatus.OPEN,
            AdminDisputeStatus.ASSIGNED,
            AdminDisputeStatus.IN_PROGRESS,
            AdminDisputeStatus.REOPENED,
          ],
        },
      },
      select: { id: true },
    });

    if (existingOpen) {
      throw new BadRequestException('An active dispute already exists for this order');
    }

    const dispute = await this.prisma.dispute.create({
      data: {
        id: randomUUID(),
        type: DisputeType.ORDER,
        reporter: { connect: { id: actorId } },
        targetType: 'ORDER',
        targetId: context.orderId,
        description: description.trim(),
        status: AdminDisputeStatus.OPEN,
      },
      select: { id: true },
    });

    const message = await this.createActionMessageForContext({
      contextType: MessageContextType.STANDARD_ORDER,
      contextId: context.orderId,
      actorId,
      actorRole,
      threadStatus: this.policy.resolveThreadStatusForOrder(context.status),
      brandId: context.brandId,
      buyerId: context.buyerId,
      brandOwnerUserId: context.brandOwnerUserId,
      bodyText: `${origin === 'BUYER' ? 'Buyer' : 'Brand'} opened a dispute for this order.`,
      metadata: {
        eventType: 'STANDARD_ORDER_DISPUTE_OPENED',
        disputeId: dispute.id,
        description: description.trim(),
      },
      origin,
    });

    return {
      statusCode: 201,
      message: 'Order dispute opened and posted to thread',
      disputeId: dispute.id,
      messageId: message.id,
    };
  }

  private async createActionMessageForContext(params: {
    contextType: MessageContextType;
    contextId: string;
    actorId: string;
    actorRole: 'BUYER' | 'BRAND_OWNER';
    threadStatus: MessageThreadStatus;
    brandId: string;
    buyerId: string | null;
    brandOwnerUserId: string;
    bodyText: string;
    metadata: Record<string, unknown>;
    origin: 'BUYER' | 'BRAND';
  }) {
    const thread = await this.getOrCreateThreadInTx(
      this.prisma,
      params.contextType,
      params.contextId,
      params.brandId,
      params.buyerId,
      params.brandOwnerUserId,
      params.threadStatus,
    );

    const actionMessage = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderUserId: null,
        senderRole: MessageParticipantRole.SYSTEM,
        kind: MessageKind.SYSTEM,
        bodyText: params.bodyText,
        metadataJson: {
          ...params.metadata,
          source: 'MESSAGING_ACTION',
          origin: params.origin,
          actorId: params.actorId,
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.messageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: actionMessage.id,
        lastMessageAt: actionMessage.createdAt,
        lastVisibleMessageAt: actionMessage.createdAt,
        lastMessagePreview: (params.bodyText || '').slice(0, 200),
        lastSenderUserId: null,
      },
    });

    const participants = await this.prisma.messageThreadParticipant.findMany({
      where: { threadId: thread.id },
      select: { userId: true, role: true },
    });

    const recipients = participants.filter((participant) => participant.userId !== params.actorId);
    if (recipients.length > 0) {
      await this.prisma.messageNotificationOutbox.createMany({
        data: recipients.map((recipient) => ({
          threadId: thread.id,
          messageId: actionMessage.id,
          recipientId: recipient.userId,
          notificationType: NotificationType.MESSAGE_RECEIVED,
          payloadJson: {
            threadId: thread.id,
            messageId: actionMessage.id,
            contextType: thread.contextType,
            orderId: thread.orderId,
            customOrderId: thread.customOrderId,
            actionType: params.metadata.eventType ?? null,
            targetUrl: this.resolveThreadTargetUrl(
              thread.contextType,
              thread.orderId,
              thread.customOrderId,
              thread.brandId,
              recipient.role,
              thread.id,
              actionMessage.id,
            ),
          } as Prisma.InputJsonValue,
        })),
      });
    }

    const recipientIds = participants.map((participant) => participant.userId);
    await this.sideEffects.dispatchMessageOutboxForMessage(actionMessage.id);
    this.sideEffects.emitMessageCreated(thread, recipientIds, {
      id: actionMessage.id,
      senderRole: actionMessage.senderRole,
      createdAt: actionMessage.createdAt,
    });
    this.sideEffects.emitThreadInvalidation(thread, recipientIds);

    return actionMessage;
  }

  private resolveThreadTargetUrl(
    contextType: MessageContextType,
    orderId: string | null,
    customOrderId: string | null,
    brandId: string | null,
    recipientRole: MessageParticipantRole,
    threadId?: string,
    messageId?: string,
  ): string {
    const qp = new URLSearchParams();
    if (threadId) qp.set('thread', threadId);
    if (messageId) qp.set('messageId', messageId);

    if (contextType === MessageContextType.CUSTOM_ORDER && customOrderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER) {
        qp.set('customOrderId', customOrderId);
        return `/studio/messages?${qp.toString()}`;
      }
      if (recipientRole === MessageParticipantRole.ADMIN) {
        return `/admin/custom-orders/${customOrderId}#messages`;
      }
      qp.set('customOrderId', customOrderId);
      return `/messages?${qp.toString()}`;
    }

    if (contextType === MessageContextType.STANDARD_ORDER && orderId) {
      if (recipientRole === MessageParticipantRole.BRAND_OWNER && brandId) {
        qp.set('orderId', orderId);
        qp.set('openChat', '1');
        return `/studio?tab=orders&${qp.toString()}`;
      }
      qp.set('orderId', orderId);
      return `/messages?${qp.toString()}`;
    }

    return '/settings?tab=notifications';
  }
}
