import { MessageParticipantRole } from '@prisma/client';
import {
  advanceMessageReadState,
  nextMessageTimestamp,
  withMessagingTransaction,
} from './messaging-transaction.util';

const time = new Date('2026-10-22T00:00:00.000Z');
const low = '00000000-0000-4000-8000-000000000001';
const high = '00000000-0000-4000-8000-000000000002';
const participant = (previous: any) => ({
  messageThreadParticipant: {
    findUnique: jest.fn().mockResolvedValue(previous),
    upsert: jest.fn(),
  },
});

it('keeps a newer recipient watermark when an older read request arrives later', async () => {
  const tx = participant({ lastReadAt: time, lastReadMessageId: high });
  const result = await advanceMessageReadState(
    tx as any,
    'thread',
    'actor',
    MessageParticipantRole.BUYER,
    { id: low, createdAt: new Date(time.getTime() - 100) },
  );
  expect(result).toEqual({ lastReadAt: time, lastReadMessageId: high });
  expect(tx.messageThreadParticipant.upsert.mock.calls[0][0].update).toEqual({
    role: MessageParticipantRole.BUYER,
  });
});

it('orders legacy equal-timestamp messages by UUID in either request order', async () => {
  const tx = participant({ lastReadAt: time, lastReadMessageId: low });
  expect(
    await advanceMessageReadState(
      tx as any,
      'thread',
      'actor',
      MessageParticipantRole.BUYER,
      { id: high, createdAt: time },
    ),
  ).toEqual({ lastReadAt: time, lastReadMessageId: high });
  tx.messageThreadParticipant.findUnique.mockResolvedValue({
    lastReadAt: time,
    lastReadMessageId: high,
  });
  expect(
    await advanceMessageReadState(
      tx as any,
      'thread',
      'actor',
      MessageParticipantRole.BUYER,
      { id: low, createdAt: time },
    ),
  ).toEqual({ lastReadAt: time, lastReadMessageId: high });
});

it('does not mark future content read when a new participant opens an empty thread', async () => {
  const tx = participant(null);
  expect(
    await advanceMessageReadState(
      tx as any,
      'thread',
      'actor',
      MessageParticipantRole.BUYER,
      null,
    ),
  ).toEqual({ lastReadAt: null, lastReadMessageId: null });
});

it('clamps a backward database clock after the previous locked message timestamp', async () => {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ now: new Date(time.getTime() - 1000) }]),
  };
  expect(await nextMessageTimestamp(tx as any, time)).toEqual(
    new Date(time.getTime() + 1),
  );
});

it('fails closed rather than inventing a timestamp if the database clock is missing', async () => {
  await expect(
    nextMessageTimestamp(
      { $queryRaw: jest.fn().mockResolvedValue([]) } as any,
      null,
    ),
  ).rejects.toThrow('Message clock unavailable');
});

it('retries a unique-key conflict in a fresh complete transaction', async () => {
  const work = jest.fn();
  const prisma = {
    $transaction: jest
      .fn()
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockResolvedValueOnce('replay'),
  };
  expect(await withMessagingTransaction(prisma as any, work)).toBe('replay');
  expect(prisma.$transaction.mock.calls).toEqual([[work], [work]]);
});

it('does not retry application errors or execute external effects in a retry callback', async () => {
  const prisma = {
    $transaction: jest
      .fn()
      .mockRejectedValue(new Error('attachment is not available')),
  };
  await expect(
    withMessagingTransaction(prisma as any, jest.fn()),
  ).rejects.toThrow('attachment is not available');
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});
