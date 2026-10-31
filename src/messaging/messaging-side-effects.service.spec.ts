import {
  MessageContextType,
  MessageKind,
  MessageOutboxStatus,
  MessageParticipantRole,
  MessageThreadStatus,
  MessageVisibilityState,
  NotificationType,
} from '@prisma/client';
import { MessagingSideEffectsService } from './messaging-side-effects.service';

jest.mock('src/upload/upload.service', () => ({ UploadService: class {} }));

describe('MessagingSideEffectsService', () => {
  const buildService = () => {
    const prisma = {
      messageNotificationOutbox: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
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
      $queryRaw: jest.fn().mockResolvedValue([]),
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
      cleanupOrphanedMessageFiles: jest.fn().mockResolvedValue(0),
    } as any;

    const service = new MessagingSideEffectsService(
      prisma,
      notificationsQueue,
      events,
      uploadService,
    );

    return { service, prisma, notificationsQueue };
  };

  it('delegates the 48-hour orphan cutoff to one bounded cleanup command', async () => {
    const { service, prisma } = buildService();
    const uploads = (service as any).uploadService;
    const before = Date.now() - 48 * 3600000;
    await service.cleanupOrphanedMessageUploads(25);
    const [cutoff, limit] = uploads.cleanupOrphanedMessageFiles.mock.calls[0];
    expect(limit).toBe(25);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 48 * 3600000);
    expect(uploads.cleanupOrphanedMessageFiles).toHaveBeenCalledTimes(1);
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    expect(prisma.fileUpload.findMany).not.toHaveBeenCalled();
  });

  it('retains a failed orphan batch for a later sweep without per-file storage calls', async () => {
    const { service } = buildService();
    const uploads = (service as any).uploadService;
    uploads.cleanupOrphanedMessageFiles.mockRejectedValue(new Error('database unavailable'));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    await expect(service.cleanupOrphanedMessageUploads()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
    expect(uploads.deleteFile).not.toHaveBeenCalled();
  });

  it('dispatchPendingMessageOutbox claims each recipient row once in a bounded batch', async () => {
    const { service, prisma, notificationsQueue } = buildService();

    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'outbox_1',
        messageId: 'msg_1',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
        recipientId: 'recipient_1', notificationType: NotificationType.MESSAGE_RECEIVED,
      },
      {
        id: 'outbox_2',
        messageId: 'msg_1',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
        recipientId: 'recipient_2', notificationType: NotificationType.MESSAGE_RECEIVED,
      },
      {
        id: 'outbox_3',
        messageId: 'msg_2',
        status: MessageOutboxStatus.PENDING,
        availableAt: new Date(),
        attempts: 0,
        recipientId: 'recipient_3', notificationType: NotificationType.MESSAGE_RECEIVED,
      },
    ]);

    await service.dispatchPendingMessageOutbox();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notificationsQueue.enqueueFanout).toHaveBeenCalledTimes(3);
    expect(prisma.messageNotificationOutbox.findMany).not.toHaveBeenCalled();
  });

  const deliveryRow = (attempts = 1) => ({
    id: '4465a9a3-b218-4710-81cd-56c671c8a332', messageId: 'message', threadId: 'thread',
    recipientId: 'recipient', notificationType: NotificationType.MESSAGE_RECEIVED,
    payloadJson: { messageId: 'message', actorUserId: 'sender' }, attempts,
  });

  it('uses the same durable IDs after enqueue succeeds but acknowledgement fails', async () => {
    const { service, prisma, notificationsQueue } = buildService();
    prisma.$queryRaw.mockResolvedValue([deliveryRow()]);
    prisma.messageNotificationOutbox.updateMany.mockRejectedValueOnce(new Error('database connection lost')).mockResolvedValue({ count: 1 });
    await service.dispatchPendingMessageOutbox();
    await service.dispatchPendingMessageOutbox();
    expect(notificationsQueue.enqueueFanout.mock.calls[0]).toEqual(notificationsQueue.enqueueFanout.mock.calls[1]);
    expect(notificationsQueue.enqueueFanout.mock.calls[0]).toEqual([
      expect.objectContaining({ notificationId: deliveryRow().id, recipientIds: ['recipient'], actorId: 'sender' }),
      { jobId: `message-outbox-${deliveryRow().id}` },
    ]);
    expect(prisma.messageNotificationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: MessageOutboxStatus.FAILED, processingLeaseToken: null }),
    }));
  });

  it('fences completion by the current lease so a stale worker cannot overwrite a new owner', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw.mockResolvedValue([deliveryRow()]);
    prisma.messageNotificationOutbox.updateMany.mockResolvedValue({ count: 0 });
    await service.dispatchPendingMessageOutbox();
    expect(prisma.messageNotificationOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: deliveryRow().id, status: MessageOutboxStatus.PROCESSING, processingLeaseToken: expect.any(String) },
      data: expect.objectContaining({ status: MessageOutboxStatus.COMPLETED, processingLeaseToken: null, processingLeaseUntil: null }),
    });
  });

  it('includes stale processing leases in the claim and caps every claim at 100 rows', async () => {
    const { service, prisma } = buildService();
    await service.dispatchPendingMessageOutbox(1000000);
    const [sql, ...parameters] = prisma.$queryRaw.mock.calls[0];
    expect(sql.join(' ')).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql.join(' ')).toContain('"processingLeaseUntil"<=(CURRENT_TIMESTAMP AT TIME ZONE');
    expect(sql.join(' ')).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'");
    expect(parameters).toContain(100);
    expect(parameters).not.toContain(1000000);
  });

  it('records a recoverable failure when enqueue fails before accepting the job', async () => {
    const { service, prisma, notificationsQueue } = buildService();
    prisma.$queryRaw.mockResolvedValue([deliveryRow()]);
    notificationsQueue.enqueueFanout.mockRejectedValue(new Error('Redis unavailable'));
    await service.dispatchPendingMessageOutbox();
    expect(prisma.messageNotificationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ processingLeaseToken: expect.any(String) }),
      data: expect.objectContaining({ status: MessageOutboxStatus.FAILED, lastError: 'Redis unavailable', availableAt: expect.any(Date), processingLeaseUntil: null }),
    }));
  });

  it('bounds a hung enqueue and releases its lease for later retry', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, notificationsQueue } = buildService();
      prisma.$queryRaw.mockResolvedValue([deliveryRow()]);
      notificationsQueue.enqueueFanout.mockImplementation(() => new Promise(() => undefined));
      const dispatch = service.dispatchPendingMessageOutbox();
      await jest.advanceTimersByTimeAsync(5001);
      await dispatch;
      expect(prisma.messageNotificationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: MessageOutboxStatus.FAILED, lastError: 'Notification enqueue timed out' }),
      }));
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('enqueueUnreadMessageReminders skips participants with a recent reminder', async () => {
    const { service, prisma } = buildService();

    const now = new Date();
    prisma.messageThreadParticipant.findMany.mockResolvedValue([
      {
        threadId: 'thread_1',
        userId: 'user_1',
        // BRAND_OWNER, because the nudge is only sent to the side that owes a
        // reply. A BUYER here would be skipped before the cooldown is reached
        // and the test would pass for the wrong reason.
        role: MessageParticipantRole.BRAND_OWNER,
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
        role: MessageParticipantRole.BRAND_OWNER,
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
    prisma.messageNotificationOutbox.createMany.mockResolvedValue({ count: 1 });

    await service.enqueueUnreadMessageReminders();

    expect(prisma.messageNotificationOutbox.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.messageNotificationOutbox.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          threadId: 'thread_2',
          recipientId: 'user_1',
          notificationType: NotificationType.MESSAGE_UNREAD_REMINDER,
        }),
      ],
    });
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
    prisma.messageNotificationOutbox.createMany.mockResolvedValue({ count: 1 });

    await service.enqueueUnreadMessageReminders();

    /*
      One row, not two: the buyer participant is skipped.

      "You have unread order messages waiting" is a nudge for the side that owes
      a reply. For a shopper it is not a task — they are waiting on the brand,
      the thread is one tap away in their inbox, and this cron fires every 30
      minutes until they open it. For a brand an unread thread IS a piece of
      work sitting still, which is what the reminder is for.
    */
    expect(prisma.messageNotificationOutbox.createMany).toHaveBeenCalledTimes(1);

    const createdRows =
      prisma.messageNotificationOutbox.createMany.mock.calls[0][0].data;
    expect(createdRows).toHaveLength(1);
    const brandRow = createdRows.find(
      (row: any) => row.recipientId === 'brand_owner_1',
    );
    const buyerRow = createdRows.find(
      (row: any) => row.recipientId === 'buyer_1',
    );

    expect(buyerRow).toBeUndefined();
    expect((brandRow?.payloadJson as Record<string, any>)?.targetUrl).toBe(
      '/studio?tab=orders&thread=thread_brand&messageId=msg_brand&orderId=order_brand&openChat=1',
    );
  });

  it('enqueueUnreadMessageReminders never nudges a shopper', async () => {
    const { service, prisma } = buildService();

    const now = new Date();
    prisma.messageThreadParticipant.findMany.mockResolvedValue([
      {
        threadId: 'thread_buyer',
        userId: 'buyer_only',
        role: MessageParticipantRole.BUYER,
        lastReadAt: null,
        thread: {
          id: 'thread_buyer',
          contextType: MessageContextType.CUSTOM_ORDER,
          customOrderId: 'co_buyer',
          orderId: null,
          brandId: 'brand_1',
          lastMessageAt: now,
          lastMessageId: 'msg_buyer',
          lastSenderUserId: 'brand_owner_1',
        },
      },
    ]);
    prisma.messageNotificationOutbox.findMany.mockResolvedValue([]);
    prisma.messageNotificationOutbox.create.mockResolvedValue({ id: 'new_row' });

    await service.enqueueUnreadMessageReminders();

    // Every other condition is satisfied — unread, not the last sender, no
    // cooldown. The role is the only thing stopping it.
    expect(prisma.messageNotificationOutbox.create).not.toHaveBeenCalled();
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

    prisma.$transaction.mockImplementation(
      async (callback: (tx: any) => Promise<unknown>) => callback(tx),
    );

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
