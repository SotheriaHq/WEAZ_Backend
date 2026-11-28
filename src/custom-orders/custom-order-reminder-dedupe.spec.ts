import { NotificationType } from '@prisma/client';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';

/**
 * WIEZ-P02-0001: outbox reminders must honour their dedupe window. The
 * dispatcher gives each outbox row a durable notificationId, which skips the
 * notification service's semantic dedupe, so the window has to be enforced
 * when the outbox row is written.
 */
describe('custom-order reminder dedupe at outbox insert (WIEZ-P02-0001)', () => {
  function setup(alreadyNotified: string[] = []) {
    const tx = {
      // Advisory lock. It must go through $executeRaw: pg_advisory_xact_lock
      // returns void, which $queryRaw cannot deserialise (caught on real PG).
      $executeRaw: jest.fn().mockResolvedValue(1),
      // Recipients with a matching row inside the window
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(alreadyNotified.map((recipientId) => ({ recipientId }))),
      customOrderNotificationOutbox: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      customOrderNotificationOutbox: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new CustomOrderSideEffectsService(prisma as any, {} as any);
    return { prisma, tx, service };
  }

  const reminder = {
    customOrderId: '11111111-1111-4111-8111-111111111111',
    notificationType: NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
    payload: { customOrderId: 'o', status: 'IN_PRODUCTION', hoursWaiting: 30 },
    dedupeMs: 18 * 60 * 60 * 1000,
    dedupeMatch: { customOrderId: 'o', status: 'IN_PRODUCTION' },
  };

  it('inserts for recipients without a matching row in the window, inside one locked transaction', async () => {
    const { prisma, tx, service } = setup();
    await service.enqueueNotification({ ...reminder, recipientIds: ['buyer'] });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const lockSql = (tx.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    const lookupSql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(lookupSql).toContain('"payloadJson" @>');
    expect(lookupSql).toContain(`"status" <> 'SKIPPED'`);
    // The containment value is the stable match, never the changing counter.
    expect(tx.$queryRaw.mock.calls[0]).toContain(JSON.stringify(reminder.dedupeMatch));
    expect(tx.customOrderNotificationOutbox.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ recipientId: 'buyer', dedupeMs: reminder.dedupeMs })],
    });
    expect(prisma.customOrderNotificationOutbox.createMany).not.toHaveBeenCalled();
  });

  it('skips recipients already reminded inside the window and inserts only the rest', async () => {
    const { tx, service } = setup(['admin-a']);
    await service.enqueueNotification({ ...reminder, recipientIds: ['admin-a', 'admin-b'] });
    expect(tx.customOrderNotificationOutbox.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ recipientId: 'admin-b' })],
    });
  });

  it('writes nothing when every recipient was already reminded', async () => {
    const { tx, service } = setup(['buyer']);
    await service.enqueueNotification({ ...reminder, recipientIds: ['buyer'] });
    expect(tx.customOrderNotificationOutbox.createMany).not.toHaveBeenCalled();
  });

  it("uses the caller's transaction when one is supplied", async () => {
    const { prisma, tx, service } = setup();
    await service.enqueueNotification({ ...reminder, recipientIds: ['buyer'] }, tx as any);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.customOrderNotificationOutbox.createMany).toHaveBeenCalledTimes(1);
  });

  it('leaves callers that do not opt in unchanged (no lock, no lookup)', async () => {
    const { prisma, tx, service } = setup();
    const { dedupeMatch: _omit, ...plain } = reminder;
    await service.enqueueNotification({ ...plain, recipientIds: ['buyer'] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.customOrderNotificationOutbox.createMany).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe when the window is zero even if a match is given', async () => {
    const { prisma, service } = setup();
    await service.enqueueNotification({ ...reminder, dedupeMs: 0, recipientIds: ['buyer'] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.customOrderNotificationOutbox.createMany).toHaveBeenCalledTimes(1);
  });
});
