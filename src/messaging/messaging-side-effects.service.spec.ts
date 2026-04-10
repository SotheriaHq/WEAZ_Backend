import { MessageContextType, MessageKind, MessageOutboxStatus, MessageParticipantRole, MessageThreadStatus, MessageVisibilityState, NotificationType } from '@prisma/client';
import { MessagingSideEffectsService } from './messaging-side-effects.service';

describe('MessagingSideEffectsService', () => {
  const buildService = () => {
    const prisma = {
      messageNotificationOutbox: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      messageThreadParticipant: {
        findMany: jest.fn(),
      },
      messageThread: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      message: {
        updateMany: jest.fn(),
      },
      fileUpload: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(),
    } as any;

    const notificationsQueue = {
      enqueueFanout: jest.fn(),
    } as any;

    const events = {
      server: {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      },
    } as any;

    const uploadService = {
      deleteFile: jest.fn(),
    } as any;

    const service = new MessagingSideEffectsService(
      prisma,
      notificationsQueue,
      events,
      uploadService,
    );

    return { service, prisma };
  };

  it('dispatchPendingMessageOutbox de-duplicates message ids before dispatch', async () => {
    const { service, prisma } = buildService();

    prisma.messageNotificationOutbox.findMany.mockResolvedValue([
      {
        id: 'outbox_1',
        messageId: 'msg_1',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
      },
      {
        id: 'outbox_2',
        messageId: 'msg_1',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
      },
      {
        id: 'outbox_3',
        messageId: 'msg_2',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
      },
    ]);

    const dispatchSpy = jest
      .spyOn(service, 'dispatchMessageOutboxForMessage')
      .mockResolvedValue(undefined);

    await service.dispatchPendingMessageOutbox();

    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy).toHaveBeenCalledWith('msg_1');
    expect(dispatchSpy).toHaveBeenCalledWith('msg_2');
  });

  it('enqueueUnreadMessageReminders skips participants with a recent reminder', async () => {
    const { service, prisma } = buildService();

    const now = new Date();
    prisma.messageThreadParticipant.findMany.mockResolvedValue([
      {
        threadId: 'thread_1',
        userId: 'user_1',
        role: MessageParticipantRole.BUYER,
        lastReadAt: null,
        thread: {
          id: 'thread_1',
          contextType: MessageContextType.CUSTOM_ORDER,
          customOrderId: 'co_1',
          orderId: null,
          brandId: 'brand_1',
          lastMessageAt: now,
          lastMessageId: 'msg_1',
          lastSenderUserId: 'user_2',
        },
      },
      {
        threadId: 'thread_2',
        userId: 'user_1',
        role: MessageParticipantRole.BUYER,
        lastReadAt: null,
        thread: {
          id: 'thread_2',
          contextType: MessageContextType.CUSTOM_ORDER,
          customOrderId: 'co_2',
          orderId: null,
          brandId: 'brand_2',
          lastMessageAt: now,
          lastMessageId: 'msg_2',
          lastSenderUserId: 'user_2',
        },
      },
    ]);

    prisma.messageNotificationOutbox.findMany.mockResolvedValue([
      { threadId: 'thread_1', recipientId: 'user_1' },
    ]);
    prisma.messageNotificationOutbox.create.mockResolvedValue({ id: 'new_row' });

    await service.enqueueUnreadMessageReminders();

    expect(prisma.messageNotificationOutbox.create).toHaveBeenCalledTimes(1);
    expect(prisma.messageNotificationOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: 'thread_2',
          recipientId: 'user_1',
          notificationType: NotificationType.MESSAGE_UNREAD_REMINDER,
        }),
      }),
    );
  });

  it('enqueueUnreadMessageReminders builds canonical standard-order deep links', async () => {
    const { service, prisma } = buildService();

    const now = new Date();
    prisma.messageThreadParticipant.findMany.mockResolvedValue([
      {
        threadId: 'thread_brand',
        userId: 'brand_owner_1',
        role: MessageParticipantRole.BRAND_OWNER,
        lastReadAt: null,
        thread: {
          id: 'thread_brand',
          contextType: MessageContextType.STANDARD_ORDER,
          customOrderId: null,
          orderId: 'order_brand',
          brandId: 'brand_1',
          lastMessageAt: now,
          lastMessageId: 'msg_brand',
          lastSenderUserId: 'buyer_1',
        },
      },
      {
        threadId: 'thread_buyer',
        userId: 'buyer_1',
        role: MessageParticipantRole.BUYER,
        lastReadAt: null,
        thread: {
          id: 'thread_buyer',
          contextType: MessageContextType.STANDARD_ORDER,
          customOrderId: null,
          orderId: 'order_buyer',
          brandId: 'brand_2',
          lastMessageAt: now,
          lastMessageId: 'msg_buyer',
          lastSenderUserId: 'brand_owner_2',
        },
      },
    ]);

    prisma.messageNotificationOutbox.findMany.mockResolvedValue([]);
    prisma.messageNotificationOutbox.create.mockResolvedValue({ id: 'new_row' });

    await service.enqueueUnreadMessageReminders();

    expect(prisma.messageNotificationOutbox.create).toHaveBeenCalledTimes(2);

    const createdRows = prisma.messageNotificationOutbox.create.mock.calls.map(
      (call: any[]) => call[0].data,
    );
    const brandRow = createdRows.find(
      (row: any) => row.recipientId === 'brand_owner_1',
    );
    const buyerRow = createdRows.find(
      (row: any) => row.recipientId === 'buyer_1',
    );

    expect((brandRow?.payloadJson as Record<string, any>)?.targetUrl).toBe(
      '/studio?tab=orders&thread=thread_brand&messageId=msg_brand&orderId=order_brand&openChat=1',
    );
    expect((buyerRow?.payloadJson as Record<string, any>)?.targetUrl).toBe(
      '/messages?thread=thread_buyer&messageId=msg_buyer&orderId=order_buyer',
    );
  });

  it('cleanupExpiredClosedThreads redacts user messages and archives eligible threads', async () => {
    const { service, prisma } = buildService();

    prisma.messageThread.findMany.mockResolvedValue([
      { id: 'thread_1' },
      { id: 'thread_2' },
    ]);

    const tx = {
      message: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      messageThread: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as any;

    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(tx));

    await service.cleanupExpiredClosedThreads();

    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: { in: ['thread_1', 'thread_2'] },
          kind: MessageKind.USER,
        }),
        data: expect.objectContaining({
          visibilityState: MessageVisibilityState.REDACTED,
          moderationReason: 'RETENTION_EXPIRED',
        }),
      }),
    );

    expect(tx.messageThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['thread_1', 'thread_2'] } },
        data: expect.objectContaining({ status: MessageThreadStatus.ARCHIVED }),
      }),
    );
  });
});
