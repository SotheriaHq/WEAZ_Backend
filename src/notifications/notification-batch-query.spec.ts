import { randomUUID } from 'node:crypto';
import { NotificationType, Prisma } from '@prisma/client';
import { claimNotificationChannels } from './notification-channel-query';
import { NotificationsService } from './notifications.service';
import { createHash } from 'node:crypto';

jest.mock('./notification-channel-query', () => ({
  claimNotificationChannels: jest.fn(),
  reapExhaustedNotificationChannels: jest.fn().mockResolvedValue(0),
  cleanupNotificationChannels: jest.fn().mockResolvedValue(0),
}));

function fixture(count = 25) {
  const written = new Map<string, any>(),
    channels = new Map<string, any>();
  const rows = Array.from({ length: count }, () => ({
    id: randomUUID(),
    email: 'a@example.invalid',
    notificationSettings: {},
    globalEnabled: true,
    securityCriticalEnabled: true,
    scenarios: {},
  }));
  const prisma = {
    $queryRaw: jest
      .fn()
      .mockImplementation(async (query) =>
        query.text.includes('FROM "User"')
          ? rows.filter((row) => query.values.includes(row.id))
          : [],
      ),
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userEmailPreference: { findUnique: jest.fn() },
    userEmailScenarioPreference: { findUnique: jest.fn() },
    emailSuppression: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    patchConnection: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    notification: {
      create: jest.fn().mockImplementation(async ({ data }) => {
        const row = {
          id: data.id,
          recipientId: data.recipientId ?? data.recipient?.connect.id,
          actorId: data.actorId ?? data.actor?.connect.id ?? null,
          type: data.type,
          payload: data.payload,
          isRead: false,
          createdAt: new Date(),
        };
        written.set(row.id, row);
        return row;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    notificationChannelOutbox: {
      create: jest.fn(async ({ data }) => {
        const notification = written.get(data.id);
        const row = {
          ...data,
          emailPolicyJson:
            data.emailPolicyJson === Prisma.DbNull
              ? null
              : data.emailPolicyJson,
          pushPayloadJson:
            data.pushPayloadJson === Prisma.DbNull
              ? null
              : data.pushPayloadJson,
          recipientId: notification.recipientId,
          actorId: notification.actorId,
          notificationType: notification.type,
          payload: notification.payload,
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
          createdAt: new Date(),
        };
        channels.set(row.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = channels.get(where.id);
        if (
          !row ||
          (where.status && row.status !== where.status) ||
          (where.lockOwner && row.lockOwner !== where.lockOwner)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (work) => work(prisma));
  (claimNotificationChannels as jest.Mock).mockImplementation(
    async (_tx, take, ids) => {
      const selected = [...channels.values()]
        .filter(
          (row) =>
            (!ids ||
              (Array.isArray(ids) ? ids.includes(row.id) : row.id === ids)) &&
            ['PENDING', 'FAILED'].includes(row.status) &&
            row.availableAt <= new Date(),
        )
        .slice(0, take);
      selected.forEach((row) =>
        Object.assign(row, {
          status: 'PROCESSING',
          lockOwner: 'unit-owner',
          attempts: row.attempts + 1,
        }),
      );
      return selected.map((row) => ({ ...row }));
    },
  );
  const email = {
    send: jest.fn().mockResolvedValue({}),
    getAppName: () => 'WIEZ',
  };
  const push = {
    enqueue: jest.fn().mockResolvedValue({}),
    buildPushPayload: jest
      .fn()
      .mockReturnValue({
        title: 'WIEZ',
        body: 'Fixture',
        data: {},
        sound: true,
      }),
  };
  const service = new NotificationsService(
    prisma as any,
    {} as any,
    { del: jest.fn().mockResolvedValue(undefined) } as any,
    { getConfig: () => undefined } as any,
    email as any,
    {} as any,
    push as any,
    { publishOrEmit: jest.fn().mockResolvedValue(true) } as any,
  );
  (service as any).logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { rows, prisma, email, push, service };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
describe('notification policy batching', () => {
  it('loads durable identities once per 25 events and replays without per-recipient reads or side effects', async () => {
    const { rows, prisma, service, email, push } = fixture(26);
    const events = rows.map((row) => ({
      recipientId: row.id,
      type: NotificationType.THREAD,
      opts: {
        notificationId: randomUUID(),
        suppressEmail: true,
        suppressPush: true,
      },
    }));
    const first = await service.createEvents(events);
    expect(first.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    const persisted = first.map(
      (result) => (result as PromiseFulfilledResult<any>).value,
    );
    prisma.notification.findMany.mockImplementation(async ({ where }) =>
      persisted.filter((row) => where.id.in.includes(row.id)),
    );
    prisma.notification.create.mockClear();
    const replay = await service.createEvents(events);
    expect(replay.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(4);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
    expect(push.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a batched durable identity belonging to a different recipient', async () => {
    const { rows, prisma, service } = fixture(2);
    const id = randomUUID();
    prisma.notification.findMany.mockResolvedValue([
      {
        id,
        recipientId: rows[1].id,
        actorId: null,
        type: NotificationType.THREAD,
      },
    ]);
    const results = await service.createEvents([
      {
        recipientId: rows[0].id,
        type: NotificationType.THREAD,
        opts: { notificationId: id },
      },
    ]);
    expect(results[0].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason.message).toContain(
      'Notification identity',
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('reuses a durable event already written earlier in the same batch', async () => {
    const { rows, prisma, service } = fixture(1);
    const event = {
      recipientId: rows[0].id,
      type: NotificationType.THREAD,
      opts: {
        notificationId: randomUUID(),
        suppressEmail: true,
        suppressPush: true,
      },
    };
    const result = await service.createEvents([event, event]);
    expect(result.every((row) => row.status === 'fulfilled')).toBe(true);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });
  it('reads policy once for 25 recipients and uses bounded chunks for 26', async () => {
    const { rows, prisma, service } = fixture(26);
    const result = await service.createForRecipients(
      rows.map((row) => row.id),
      NotificationType.THREAD,
      { dedupeMs: 0, suppressEmail: true, suppressPush: true },
    );
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(26);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledTimes(26);
  });
  it('retains per-recipient category consent and patched-only comment privacy', async () => {
    const { rows, prisma, service } = fixture(3);
    const actorId = randomUUID();
    rows[0].notificationSettings = {
      comments: { enabled: true, fromUnpatchedUsers: false },
    };
    rows[1].notificationSettings = { comments: { enabled: false } };
    rows[2].notificationSettings = {
      comments: { enabled: true, fromUnpatchedUsers: false },
    };
    prisma.patchConnection.findMany.mockResolvedValue([
      { requesterId: actorId, targetId: rows[0].id },
    ]);
    await service.createForRecipients(
      rows.map((row) => row.id),
      NotificationType.COMMENT,
      { actorId, dedupeMs: 0, suppressEmail: true, suppressPush: true },
    );
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create.mock.calls[0][0].data.recipientId).toBe(
      rows[0].id,
    );
    expect(prisma.patchConnection.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.patchConnection.findFirst).not.toHaveBeenCalled();
  });
  it('preserves email global/scenario consent and deliverability suppression', async () => {
    const { rows, prisma, email, service } = fixture(4);
    rows.forEach((row, index) => {
      row.email = `${index}@example.invalid`;
      row.scenarios = { 'notification.PRODUCT_UPLOAD': true };
    });
    rows[1].globalEnabled = false;
    rows[2].scenarios = { 'notification.PRODUCT_UPLOAD': false };
    prisma.emailSuppression.findMany.mockResolvedValue([
      {
        recipientEmailHash: createHash('sha256')
          .update(rows[3].email)
          .digest('hex'),
      },
    ]);
    await service.createForRecipients(
      rows.map((row) => row.id),
      NotificationType.PRODUCT_UPLOAD,
      { dedupeMs: 0, suppressPush: true },
    );
    await flush();
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0]).toBe(rows[0].email);
    expect(prisma.userEmailPreference.findUnique).not.toHaveBeenCalled();
    expect(
      prisma.userEmailScenarioPreference.findUnique,
    ).not.toHaveBeenCalled();
    expect(prisma.emailSuppression.findFirst).not.toHaveBeenCalled();
  });
  it('keeps semantic and explicit-target replay, excluding self and duplicate recipients', async () => {
    const { rows, prisma, service } = fixture(2);
    prisma.$queryRaw.mockImplementation(async (query) =>
      query.text.includes('FROM "User"')
        ? rows
        : [
            {
              recipientId: rows[0].id,
              kind: 'TARGET',
              notification: {
                id: randomUUID(),
                createdAt: new Date().toISOString(),
                type: 'THREAD',
                payload: {},
              },
            },
          ],
    );
    await service.createForRecipients(
      [rows[0].id, rows[0].id, rows[1].id],
      NotificationType.THREAD,
      {
        actorId: rows[1].id,
        target: { type: 'PRODUCT', id: randomUUID() },
        dedupeMs: 60_000,
        suppressEmail: true,
        suppressPush: true,
      },
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('reports policy failures per recipient for durable retry, without write fallback', async () => {
    const { rows, prisma, service } = fixture(1);
    prisma.$queryRaw.mockRejectedValue(Error('database unavailable'));
    const result = await service.createForRecipients(
      [rows[0].id],
      NotificationType.MESSAGE_RECEIVED,
      { notificationId: randomUUID() },
    );
    expect(result[0]).toMatchObject({ status: 'rejected' });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  it('batches 26 different events while keeping targets and payloads separate', async () => {
    const { rows, prisma, service } = fixture(26);
    const events = rows.map((row, index) => ({
      recipientId: row.id,
      type:
        index % 2
          ? NotificationType.THREAD
          : NotificationType.VERIFICATION_NUDGE,
      opts: {
        actorId: randomUUID(),
        target: { type: 'PRODUCT' as const, id: randomUUID() },
        payload: { message: `Event ${index}` },
        suppressEmail: true,
        suppressPush: true,
      },
    }));
    const result = await service.createEvents(events);
    expect(result.every((value) => value.status === 'fulfilled')).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledTimes(26);
    expect(
      prisma.notification.create.mock.calls[25][0].data.payload.message,
    ).toBe('Event 25');
  });

  it('deduplicates repeated targets within the same mixed-event batch without suppressing a different target', async () => {
    const { rows, prisma, service } = fixture(1);
    const target = { type: 'PRODUCT' as const, id: randomUUID() };
    const event = {
      recipientId: rows[0].id,
      type: NotificationType.THREAD,
      opts: {
        target,
        dedupeMs: 60000,
        suppressEmail: true,
        suppressPush: true,
      },
    };
    await service.createEvents([
      event,
      event,
      {
        ...event,
        opts: { ...event.opts, target: { ...target, id: randomUUID() } },
      },
    ]);
    expect(prisma.notification.create).toHaveBeenCalledTimes(2);
  });

  it('keeps patched-comment privacy scoped to each actor/event', async () => {
    const { rows, prisma, service } = fixture(1);
    rows[0].notificationSettings = {
      comments: { enabled: true, fromUnpatchedUsers: false },
    };
    prisma.$queryRaw.mockImplementation(async (query) =>
      query.text.includes('FROM "User"')
        ? rows
        : query.text.includes('PatchConnection')
          ? [{ index: 0 }]
          : [],
    );
    await service.createEvents(
      [0, 1].map(() => ({
        recipientId: rows[0].id,
        type: NotificationType.COMMENT,
        opts: {
          actorId: randomUUID(),
          dedupeMs: 0,
          suppressEmail: true,
          suppressPush: true,
        },
      })),
    );
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.patchConnection.findFirst).not.toHaveBeenCalled();
  });
});
