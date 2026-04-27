import { ForbiddenException } from '@nestjs/common';
import {
  CustomOrderStatus,
  MessageContextType,
  MessageParticipantRole,
  MessageThreadStatus,
} from '@prisma/client';
import { MessagingAttachmentService } from './messaging-attachment.service';
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
        messageThread: { findFirst: jest.fn(), findUnique: jest.fn() },
        message: { findFirst: jest.fn(), create: jest.fn() },
        messageThreadParticipant: { upsert: jest.fn(), findMany: jest.fn() },
        messageNotificationOutbox: { createMany: jest.fn(), create: jest.fn() },
        $transaction: jest.fn(),
      } as any);

    const query =
      overrides?.query ??
      ({
        getMessages: jest.fn(),
        getSummariesForActor: jest.fn(),
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
    } as any;

    const adminAudit = {
      log: jest.fn(),
    } as any;

    const service = new MessagingService(
      prisma,
      adminAudit,
      attachments as MessagingAttachmentService,
      new MessagingPolicyService(),
      query,
      sideEffects,
      {} as any,
      {} as any,
    );

    return { service, prisma, query };
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
      participants: [
        { userId: 'buyer_1', role: MessageParticipantRole.BUYER },
        { userId: 'owner_1', role: MessageParticipantRole.BRAND_OWNER },
      ],
    });
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
});
