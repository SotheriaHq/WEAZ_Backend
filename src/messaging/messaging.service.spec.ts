import { ForbiddenException } from '@nestjs/common';
import {
  CustomOrderStatus,
  MessageContextType,
  MessageParticipantRole,
  MessageThreadStatus,
  NotificationType,
  UserType,
} from '@prisma/client';
import { MessagingAttachmentService } from './messaging-attachment.service';
import { MessagingAccessService } from './messaging-access.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingService } from './messaging.service';

describe('MessagingService', () => {
  const buildService = (overrides?: {
    prisma?: any;
    query?: any;
    attachments?: any;
  }) => {
    const prisma =
      overrides?.prisma ??
      ({
        customOrder: { findUnique: jest.fn() },
        order: { findUnique: jest.fn() },
        messageThread: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
        messageThreadOrderLink: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), upsert: jest.fn() },
        message: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
        messageThreadParticipant: { upsert: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
        messageNotificationOutbox: { createMany: jest.fn(), create: jest.fn() },
        user: { findUnique: jest.fn() },
        brand: { findFirst: jest.fn() },
        $transaction: jest.fn(),
      } as any);

    const query =
      overrides?.query ??
      ({
        getMessages: jest.fn(),
        getSummariesForActor: jest.fn(),
        getUnreadMessageCountForActor: jest.fn(),
        markMessagesRead: jest.fn(),
      } as any);

    const attachments =
      overrides?.attachments ??
      ({
        resolveValidatedAttachments: jest.fn().mockResolvedValue([]),
      } as any);

    const sideEffects = {
      dispatchMessageOutboxForMessage: jest.fn(),
      emitMessageCreated: jest.fn(),
      emitThreadInvalidation: jest.fn(),
      emitMessageRead: jest.fn(),
    } as any;

    const adminAudit = {
      log: jest.fn(),
    } as any;

    const access = {
      assertCanReadThread: jest.fn().mockResolvedValue(undefined),
      assertCanSendMessage: jest.fn().mockResolvedValue(undefined),
      assertBrandRead: jest.fn().mockResolvedValue(undefined),
      assertBrandReply: jest.fn().mockResolvedValue(undefined),
      getBrandIdsWithPermission: jest.fn().mockResolvedValue([]),
      resolveActorThreadRole: jest.fn().mockResolvedValue(MessageParticipantRole.BRAND_OWNER),
    } as any;

    const service = new MessagingService(
      prisma,
      adminAudit,
      attachments as MessagingAttachmentService,
      access as MessagingAccessService,
      new MessagingPolicyService(),
      query,
      sideEffects,
      {} as any,
      {} as any,
    );

    return { service, prisma, query, access };
  };

  it('filters moderated messages for buyer thread listing', async () => {
    const { service, prisma, query } = buildService();

    prisma.customOrder.findUnique.mockResolvedValue({
      id: 'co_1',
      status: CustomOrderStatus.ACCEPTED,
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { ownerId: 'owner_1' },
    });
    prisma.messageThread.findFirst.mockResolvedValue({
      id: 'thread_1',
      contextType: MessageContextType.CUSTOM_ORDER,
      customOrderId: 'co_1',
      pairKey: 'BUYER_BRAND:buyer_1:brand_1',
      conversationType: 'BUYER_BRAND',
      participants: [
        { userId: 'buyer_1', role: MessageParticipantRole.BUYER },
        { userId: 'owner_1', role: MessageParticipantRole.BRAND_OWNER },
      ],
    });
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        messageThreadOrderLink: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        messageThread: {
          findFirst: prisma.messageThread.findFirst,
        },
      }),
    );
    query.getMessages.mockResolvedValue({ items: [], hasNextPage: false, endCursor: null });

    await service.listCustomOrderMessagesForBuyer('buyer_1', 'co_1', { limit: 20 });

    expect(query.getMessages).toHaveBeenCalledWith(
      'thread_1',
      { actorId: 'buyer_1', limit: 20 },
      { includeModerated: false },
    );
  });

  it('includes moderated messages for admin thread listing', async () => {
    const { service, prisma, query } = buildService();

    prisma.messageThread.findUnique.mockResolvedValue({ id: 'thread_1' });
    query.getMessages.mockResolvedValue({ items: [], hasNextPage: false, endCursor: null });

    await service.getAdminThreadMessages('admin_1', 'thread_1', { limit: 20 });

    expect(query.getMessages).toHaveBeenCalledWith(
      'thread_1',
      { limit: 20 },
      { includeModerated: true },
    );
  });

  it('re-checks context status in transaction and blocks send on race to read-only', async () => {
    const { service, prisma } = buildService();

    prisma.customOrder.findUnique
      .mockResolvedValueOnce({
        id: 'co_1',
        status: CustomOrderStatus.ACCEPTED,
        brandId: 'brand_1',
        buyerId: 'buyer_1',
        brand: { ownerId: 'owner_1' },
      })
      .mockResolvedValueOnce({
        status: CustomOrderStatus.COMPLETED,
      });

    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        customOrder: {
          findUnique: prisma.customOrder.findUnique,
        },
        order: {
          findUnique: jest.fn(),
        },
      }),
    );

    await expect(
      service.sendCustomOrderMessageForBuyer(
        'buyer_1',
        'co_1',
        { clientMessageId: 'fd6dc77c-8ce8-4c5d-a44e-3566ea8b7f6f', bodyText: 'hello' },
        'idem-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns bulk summaries keyed by requested context ids for buyer custom orders', async () => {
    const { service, prisma, query } = buildService();

    prisma.customOrder.findMany = jest.fn().mockResolvedValue([
      { id: 'co_1' },
      { id: 'co_2' },
    ]);
    prisma.messageThread.findMany = jest.fn().mockResolvedValue([
      { id: 'thread_1', customOrderId: 'co_1', orderId: null },
      { id: 'thread_2', customOrderId: 'co_2', orderId: null },
    ]);

    query.getSummariesForActor.mockResolvedValue({
      thread_1: { id: 'thread_1', hasUnread: true, unreadCount: 3, responseRequired: true },
      thread_2: { id: 'thread_2', hasUnread: false, unreadCount: 0, responseRequired: false },
    });

    const result = await service.getBulkSummariesForCustomOrdersBuyer('buyer_1', {
      contextIds: ['co_1', 'co_2'],
      includeUnreadCount: 'true',
    });

    expect(result.items).toEqual([
      {
        contextId: 'co_1',
        summary: { id: 'thread_1', hasUnread: true, unreadCount: 3, responseRequired: true },
      },
      {
        contextId: 'co_2',
        summary: { id: 'thread_2', hasUnread: false, unreadCount: 0, responseRequired: false },
      },
    ]);
  });

  it('returns aggregate unread message count from messaging read state only', async () => {
    const { service, query } = buildService();
    query.getUnreadMessageCountForActor.mockResolvedValue(7);

    await expect(service.getUnreadMessageCountForActor('user_1')).resolves.toEqual({
      unreadCount: 7,
    });

    expect(query.getUnreadMessageCountForActor).toHaveBeenCalledWith('user_1');
  });

  it('resolves messageId to an authorized conversation route', async () => {
    const { service, prisma } = buildService();

    prisma.message.findUnique.mockResolvedValue({ threadId: 'thread_1' });
    prisma.messageThreadParticipant.findUnique.mockResolvedValue({
      role: MessageParticipantRole.BUYER,
      thread: {
        id: 'thread_1',
        contextType: MessageContextType.STANDARD_ORDER,
        orderId: 'order_1',
        customOrderId: null,
        brandId: 'brand_1',
        buyerId: 'buyer_1',
        buyerUserId: 'buyer_1',
        subjectSnapshotJson: null,
      },
    });

    await expect(
      service.resolveConversationForActor('buyer_1', { messageId: 'message_1' }),
    ).resolves.toMatchObject({
      threadId: 'thread_1',
      conversationId: 'thread_1',
      orderId: 'order_1',
      brandId: 'brand_1',
      customerId: 'buyer_1',
    });
  });

  it('does not resolve another user conversation by messageId', async () => {
    const { service, prisma, access } = buildService();

    prisma.message.findUnique.mockResolvedValue({ threadId: 'thread_1' });
    access.assertCanReadThread.mockRejectedValue(new ForbiddenException('Thread access denied'));
    prisma.messageThreadParticipant.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveConversationForActor('intruder_1', { messageId: 'message_1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('starts order conversations through the existing order messaging path', async () => {
    const { service } = buildService();
    const sendOrderMessageForBuyer = jest
      .spyOn(service, 'sendOrderMessageForBuyer')
      .mockResolvedValue({ statusCode: 201 } as any);

    await service.startConversationForActor(
      'buyer_1',
      {
        orderId: 'order_1',
        clientMessageId: 'client_1',
        bodyText: 'Hello',
      },
      'client_1',
    );

    expect(sendOrderMessageForBuyer).toHaveBeenCalledWith(
      'buyer_1',
      'order_1',
      expect.objectContaining({ clientMessageId: 'client_1' }),
      'client_1',
    );
  });

  it('adds native routing params to message notification payloads', async () => {
    const { service, prisma } = buildService();
    const createdAt = new Date('2026-05-01T12:00:00.000Z');

    prisma.messageThread.findFirst.mockResolvedValue({
      id: 'thread_1',
      contextType: MessageContextType.DIRECT,
      orderId: null,
      customOrderId: null,
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      buyerUserId: 'buyer_1',
      pairKey: 'BUYER_BRAND:buyer_1:brand_1',
      conversationType: 'BUYER_BRAND',
      status: MessageThreadStatus.OPEN,
      participants: [
        { userId: 'buyer_1', role: MessageParticipantRole.BUYER },
        { userId: 'owner_1', role: MessageParticipantRole.BRAND_OWNER },
      ],
    });
    prisma.message.findFirst.mockResolvedValue(null);
    prisma.message.create.mockResolvedValue({
      id: 'message_1',
      threadId: 'thread_1',
      senderRole: MessageParticipantRole.BUYER,
      createdAt,
      sender: { firstName: 'Buyer', username: 'buyer' },
      attachments: [],
    });
    prisma.messageThread.update.mockResolvedValue({});
    prisma.messageThreadParticipant.upsert.mockResolvedValue({});
    prisma.messageNotificationOutbox.createMany.mockResolvedValue({ count: 1 });

    await service.sendMessageToThread(
      'buyer_1',
      'thread_1',
      { clientMessageId: 'client_1', bodyText: 'Hello' },
      'client_1',
    );

    expect(prisma.messageNotificationOutbox.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          threadId: 'thread_1',
          messageId: 'message_1',
          recipientId: 'owner_1',
          notificationType: NotificationType.MESSAGE_RECEIVED,
          payloadJson: expect.objectContaining({
            type: 'message',
            category: 'message',
            threadId: 'thread_1',
            conversationId: 'thread_1',
            messageId: 'message_1',
            brandId: 'brand_1',
            customerId: 'buyer_1',
            actorUserId: 'buyer_1',
          }),
        }),
      ],
    });
  });

  it('resolves existing brand-entry conversation without creating a duplicate', async () => {
    const { service, prisma } = buildService();

    prisma.user.findUnique.mockResolvedValue({ id: 'buyer_1', type: UserType.REGULAR });
    prisma.brand.findFirst.mockResolvedValueOnce({ id: 'brand_1', ownerId: 'owner_1' });
    prisma.messageThread.findFirst.mockResolvedValueOnce({ id: 'thread_1' });
    prisma.messageThreadParticipant.findUnique.mockResolvedValue({
      role: MessageParticipantRole.BUYER,
      thread: {
        id: 'thread_1',
        contextType: MessageContextType.INQUIRY,
        orderId: null,
        customOrderId: null,
        brandId: 'brand_1',
        buyerId: 'buyer_1',
        buyerUserId: 'buyer_1',
        subjectSnapshotJson: { type: 'DIRECT_BRAND_ENTRY' },
      },
    });

    await expect(
      service.resolveConversationForActor('buyer_1', { brandId: 'brand_1' }),
    ).resolves.toMatchObject({
      threadId: 'thread_1',
      brandId: 'brand_1',
      customerId: 'buyer_1',
    });

    expect(prisma.messageThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ pairKey: 'BUYER_BRAND:buyer_1:brand_1' }),
          ]),
        }),
      }),
    );
  });
});
