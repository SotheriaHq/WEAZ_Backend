import { TelegramClient, TelegramDeliveryError } from './telegram.client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramEventsService } from './telegram-events.service';
import { MonitoringReportService } from './monitoring-report.service';
import { FakeRedis, fakeConfig, fakeQueue, VALID_TOKEN } from './testing/fakes';

const respond = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

describe('TelegramClient failure classification', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends to the configured chat only', async () => {
    global.fetch = respond(200, { ok: true, result: { message_id: 9 } }) as any;
    const result = await new TelegramClient(fakeConfig()).sendMessage('hi');
    expect(result.messageId).toBe(9);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).chat_id).toBe('5229816265');
  });

  it.each([
    [429, { ok: false, parameters: { retry_after: 7 } }, 'rate_limited'],
    [401, { ok: false, description: 'Unauthorized' }, 'fatal'],
    [400, { ok: false, description: 'Bad Request: chat not found' }, 'fatal'],
    [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'fatal'],
    [502, { ok: false, description: 'Bad Gateway' }, 'retryable'],
  ])('HTTP %s → %s, never leaking the token', async (status, body, kind) => {
    global.fetch = respond(status, body) as any;
    const error = await new TelegramClient(fakeConfig()).sendMessage('x').catch((e) => e);
    expect(error).toBeInstanceOf(TelegramDeliveryError);
    expect(error.kind).toBe(kind);
    if (status === 429) expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).not.toContain(VALID_TOKEN);
  });

  it('network failure / timeout → retryable without the URL', async () => {
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error(`fetch https://api.telegram.org/bot${VALID_TOKEN}/x`), { name: 'TimeoutError' })) as any;
    const error = await new TelegramClient(fakeConfig()).sendMessage('x').catch((e) => e);
    expect(error.kind).toBe('retryable');
    expect(error.message).not.toContain(VALID_TOKEN);
  });

  it('invalid config → inactive, no network call', async () => {
    global.fetch = jest.fn() as any;
    const error = await new TelegramClient(fakeConfig({ TELEGRAM_ADMIN_CHAT_ID: 'not-a-chat' })).sendMessage('x').catch((e) => e);
    expect(error.kind).toBe('inactive');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('TelegramDeliveryService', () => {
  it('delivers once per idempotency id', async () => {
    const redis = new FakeRedis();
    const client = { sendMessage: jest.fn().mockResolvedValue({ messageId: 1 }) } as any;
    const delivery = new TelegramDeliveryService(fakeConfig(), client, fakeQueue(redis));
    expect((await delivery.deliverOnce('id1', 'x')).status).toBe('sent');
    expect((await delivery.deliverOnce('id1', 'x')).status).toBe('duplicate');
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still sends when Redis is down (duplicate beats silence)', async () => {
    const redis = new FakeRedis();
    redis.failAll = true;
    const client = { sendMessage: jest.fn().mockResolvedValue({ messageId: 1 }) } as any;
    const delivery = new TelegramDeliveryService(fakeConfig(), client, fakeQueue(redis));
    expect((await delivery.deliverOnce('id1', 'x')).status).toBe('sent');
  });
});

describe('TelegramEventsService never affects the caller', () => {
  const build = (redis: FakeRedis | null, env: Record<string, string> = {}) => {
    const queue = fakeQueue(redis);
    const config = fakeConfig(env);
    const delivery = new TelegramDeliveryService(config, {} as any, queue);
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } } as any;
    return { events: new TelegramEventsService(config, delivery, queue, prisma), queue };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('record() is synchronous and swallows queue failures', async () => {
    const { events, queue } = build(new FakeRedis());
    queue.add.mockRejectedValue(new Error('redis full'));
    expect(() => events.record({ key: 'user.registered', idempotencyKey: 'u1' })).not.toThrow();
    await flush();
  });

  it('does nothing when monitoring is disabled', async () => {
    const { events, queue } = build(new FakeRedis(), { TELEGRAM_MONITORING_ENABLED: 'false' });
    events.record({ key: 'user.registered', idempotencyKey: 'u1' });
    await flush();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('immediate events enqueue with a deterministic job id', async () => {
    const { events, queue } = build(new FakeRedis());
    events.record({ key: 'payment.failed', idempotencyKey: 'REF:FAILED' });
    events.record({ key: 'payment.failed', idempotencyKey: 'REF:FAILED' });
    await flush();
    const ids = queue.add.mock.calls.map((call: any[]) => call[2].jobId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('threshold events message exactly once, on the crossing', async () => {
    const { events, queue } = build(new FakeRedis());
    for (let i = 0; i < 40; i += 1) events.record({ key: 'auth.signup_rejected', idempotencyKey: `x${i}` });
    await flush();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('count-only events never message', async () => {
    const { events, queue } = build(new FakeRedis());
    for (let i = 0; i < 50; i += 1) events.record({ key: 'http.auth_failure', idempotencyKey: `x${i}` });
    await flush();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('MonitoringReportService scheduled delivery', () => {
  const build = (sendImpl: jest.Mock, prismaOk = true) => {
    const redis = new FakeRedis();
    const config = fakeConfig();
    const queue = fakeQueue(redis);
    const delivery = new TelegramDeliveryService(config, {} as any, queue);
    const prisma: any = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === '$transaction') {
            return () => (prismaOk ? Promise.resolve([0, 3]) : Promise.reject(new Error('db down')));
          }
          if (prop === '$executeRawUnsafe' || prop === '$queryRaw') return () => Promise.resolve([]);
          return { count: () => Promise.resolve(3), groupBy: () => Promise.resolve([]) };
        },
      },
    );
    const sentry = { isConfigured: () => false } as any;
    const infra = { snapshot: jest.fn().mockRejectedValue(new Error('probe failed')) } as any;
    const client = { sendMessage: sendImpl } as any;
    return new MonitoringReportService(prisma, config, delivery, client, sentry, infra);
  };

  it('sends once per window; a second run (restart/retry) is a duplicate', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 5 });
    const service = build(send);
    expect((await service.deliverScheduled('morning', new Date('2026-10-22T06:00:05Z'))).status).toBe('sent');
    expect((await service.deliverScheduled('morning', new Date('2026-10-22T08:00:00Z'))).status).toBe('duplicate');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('database + Sentry + infra failure still sends, labelling missing sections', async () => {
    const send = jest.fn().mockResolvedValue({ messageId: 5 });
    const service = build(send, false);
    await service.deliverScheduled('evening', new Date('2026-10-22T21:00:00Z'));
    const text: string = send.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(text).toContain('New shoppers: unavailable');
    expect(text).toContain('Issue statistics: UNAVAILABLE');
    expect(text).toContain('Snapshot unavailable');
  });

  it('a failed send can be retried and then completes exactly once', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new TelegramDeliveryError('retryable', 'down'))
      .mockResolvedValue({ messageId: 6 });
    const service = build(send);
    const at = new Date('2026-10-22T06:00:05Z');
    await expect(service.deliverScheduled('morning', at)).rejects.toThrow('down');
    expect((await service.deliverScheduled('morning', at)).status).toBe('sent');
    expect((await service.deliverScheduled('morning', at)).status).toBe('duplicate');
  });
});
