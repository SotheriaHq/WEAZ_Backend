import { NotFoundException } from '@nestjs/common';
import { MessageParticipantRole, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { retryDatabaseTransaction } from 'src/common/transaction-retry.util';

/** Retry only rolled-back DB work; callers dispatch network effects after this resolves. */
export function withMessagingTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return retryDatabaseTransaction(async () => {
    try {
      return await prisma.$transaction(work);
    } catch (error) {
      // Older API workers may still race on the existing pair/client-message unique key.
      // PostgreSQL aborts the first transaction: replay must start a fresh transaction.
      if ((error as { code?: string }).code !== 'P2002') throw error;
      return prisma.$transaction(work);
    }
  });
}

export async function lockMessageThread(
  tx: Prisma.TransactionClient,
  threadId: string,
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "MessageThread" WHERE "id"=${threadId}::uuid FOR UPDATE
  `;
  if (!locked.length) throw new NotFoundException('Message thread not found');
  const thread = await tx.messageThread.findUnique({
    where: { id: threadId },
    include: { participants: true },
  });
  if (!thread) throw new NotFoundException('Message thread not found');
  return thread;
}

export async function nextMessageTimestamp(
  tx: Prisma.TransactionClient,
  previous: Date | null,
) {
  // A separate statement after the row lock avoids transaction-start timestamps and pre-lock projections.
  const rows = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS "now"`;
  const wallTime = new Date(rows[0]?.now).getTime();
  if (!Number.isFinite(wallTime)) throw new Error('Message clock unavailable');
  return new Date(
    Math.max(wallTime, previous ? previous.getTime() + 1 : wallTime),
  );
}

/** Caller holds the thread row lock; an older request cannot regress its recipient watermark. */
export async function advanceMessageReadState(
  tx: Prisma.TransactionClient,
  threadId: string,
  actorId: string,
  role: MessageParticipantRole,
  target: { id: string; createdAt: Date } | null,
) {
  const previous = await tx.messageThreadParticipant.findUnique({
    where: { threadId_userId: { threadId, userId: actorId } },
    select: { lastReadAt: true, lastReadMessageId: true },
  });
  const advances = Boolean(
    target &&
      (!previous?.lastReadAt ||
        target.createdAt.getTime() > previous.lastReadAt.getTime() ||
        (target.createdAt.getTime() === previous.lastReadAt.getTime() &&
          (!previous.lastReadMessageId ||
            target.id > previous.lastReadMessageId))),
  );
  const next =
    advances && target
      ? { lastReadAt: target.createdAt, lastReadMessageId: target.id }
      : {
          lastReadAt: previous?.lastReadAt ?? null,
          lastReadMessageId: previous?.lastReadMessageId ?? null,
        };
  await tx.messageThreadParticipant.upsert({
    where: { threadId_userId: { threadId, userId: actorId } },
    update: { role, ...(advances ? next : {}) },
    create: { threadId, userId: actorId, role, ...next },
  });
  return next;
}
