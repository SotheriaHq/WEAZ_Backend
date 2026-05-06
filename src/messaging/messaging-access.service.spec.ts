import { ForbiddenException } from '@nestjs/common';
import { MessageThreadStatus } from '@prisma/client';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';
import { MessagingAccessService } from './messaging-access.service';

describe('MessagingAccessService', () => {
  let prisma: any;
  let permissions: any;
  let policy: any;
  let service: MessagingAccessService;

  beforeEach(() => {
    prisma = {
      brand: { findMany: jest.fn().mockResolvedValue([]) },
      brandMember: { findMany: jest.fn().mockResolvedValue([]) },
      messageThread: { findUnique: jest.fn() },
      messageThreadParticipant: { findUnique: jest.fn() },
    };
    permissions = {
      assertPermission: jest.fn(),
      hasPermission: jest.fn(),
    };
    policy = {
      assertCanSend: jest.fn((status: MessageThreadStatus) => {
        if (status !== MessageThreadStatus.OPEN) {
          throw new ForbiddenException('Thread is read-only');
        }
      }),
    };
    service = new MessagingAccessService(prisma, permissions, policy);
  });

  it('allows a direct participant to read a thread', async () => {
    prisma.messageThreadParticipant.findUnique.mockResolvedValue({ id: 'participant_1' });

    await expect(service.assertCanReadThread('buyer_1', 'thread_1')).resolves.toBeUndefined();
  });

  it('requires messages.read for brand-scoped thread read when not a direct participant', async () => {
    prisma.messageThreadParticipant.findUnique.mockResolvedValue(null);
    prisma.messageThread.findUnique.mockResolvedValue({
      brandId: 'brand_1',
      order: null,
      customOrder: null,
    });

    await service.assertCanReadThread('staff_1', 'thread_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.MESSAGES_READ,
    );
  });

  it('requires messages.reply and open thread status for brand-scoped replies', async () => {
    prisma.messageThreadParticipant.findUnique.mockResolvedValue(null);
    prisma.messageThread.findUnique
      .mockResolvedValueOnce({ status: MessageThreadStatus.OPEN })
      .mockResolvedValueOnce({ brandId: 'brand_1', order: null, customOrder: null });

    await service.assertCanSendMessage('staff_1', 'thread_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.MESSAGES_REPLY,
    );
  });

  it('blocks replies to read-only threads', async () => {
    prisma.messageThreadParticipant.findUnique.mockResolvedValue({ id: 'participant_1' });
    prisma.messageThread.findUnique.mockResolvedValue({ status: MessageThreadStatus.READ_ONLY });

    await expect(service.assertCanSendMessage('staff_1', 'thread_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
