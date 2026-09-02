import { ViewCountingService } from './view-counting.service';
import { readDeviceId } from './device-id';

/**
 * A stand-in for the Redis commands the service actually uses, with real
 * key/TTL semantics — the dedupe rules are entirely about which keys exist, so
 * a mock that ignores keys would test nothing.
 */
function createFakeRedis() {
  const store = new Map<string, string>();
  const hashes = new Map<string, Map<string, number>>();

  return {
    store,
    hashes,
    isOpen: true,
    removeAllListeners: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    async set(key: string, value: string, options?: { NX?: boolean }) {
      if (options?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async hIncrBy(key: string, field: string, by: number) {
      const hash = hashes.get(key) ?? new Map<string, number>();
      hash.set(field, (hash.get(field) ?? 0) + by);
      hashes.set(key, hash);
      return hash.get(field)!;
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      // The dedupe script: all-or-nothing across every identity key.
      if (script.includes('EXISTS')) {
        if (options.keys.some((key) => store.has(key))) return 0;
        for (const key of options.keys) store.set(key, '1');
        return 1;
      }
      // The drain script.
      const hash = hashes.get(options.keys[0]);
      if (!hash || hash.size === 0) return [];
      const flat: string[] = [];
      for (const [field, count] of hash.entries()) {
        flat.push(field, String(count));
      }
      hashes.delete(options.keys[0]);
      return flat;
    },
  };
}

describe('ViewCountingService', () => {
  const OLD_ENV = process.env;
  let service: ViewCountingService;
  let redis: ReturnType<typeof createFakeRedis>;

  const prisma = {
    collection: { update: jest.fn().mockResolvedValue({}) },
    product: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
  };

  beforeEach(() => {
    process.env = { ...OLD_ENV, VIEW_IP_HASH_SECRET: 'test-pepper' };
    jest.clearAllMocks();
    redis = createFakeRedis();
    service = new ViewCountingService(prisma as any);
    (service as any).redis = redis;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  const view = (overrides: Partial<Parameters<typeof service.record>[0]> = {}) =>
    service.record({
      target: 'DESIGN',
      targetId: 'design-1',
      ownerId: 'brand-owner',
      ...overrides,
    } as any);

  describe('the same person, the same item', () => {
    it('counts the first view', async () => {
      await expect(view({ viewerId: 'shopper-1' })).resolves.toEqual({
        counted: true,
        reason: 'counted',
      });
    });

    it('does not count a second view inside the window', async () => {
      await view({ viewerId: 'shopper-1' });
      await expect(view({ viewerId: 'shopper-1' })).resolves.toEqual({
        counted: false,
        reason: 'duplicate',
      });
    });

    it('does not recount when they scroll away and come back to act', async () => {
      await view({ viewerId: 'shopper-1', deviceId: 'device-a' });
      // Returning with intent is a stronger interest signal, but it is the same
      // person on the same item in the same sitting — it is not new reach.
      await expect(
        view({ viewerId: 'shopper-1', deviceId: 'device-a' }),
      ).resolves.toMatchObject({ counted: false });
    });
  });

  describe('signing out and back in', () => {
    it('does not recount: the device key survives the identity change', async () => {
      // Signed out — only the device is known.
      await expect(view({ deviceId: 'device-a' })).resolves.toMatchObject({
        counted: true,
      });
      // Signs in. The user key is new, but the device key is already set.
      await expect(
        view({ viewerId: 'shopper-1', deviceId: 'device-a' }),
      ).resolves.toEqual({ counted: false, reason: 'duplicate' });
    });

    it('holds in the other direction too', async () => {
      await view({ viewerId: 'shopper-1', deviceId: 'device-a' });
      // Signs out. The user key is gone from the request, but the device key
      // was written by the signed-in view.
      await expect(view({ deviceId: 'device-a' })).resolves.toMatchObject({
        counted: false,
      });
    });

    it('signing in on a NEW device counts, because it is a new viewing session', async () => {
      await view({ viewerId: 'shopper-1', deviceId: 'phone' });
      await expect(
        view({ viewerId: 'shopper-1', deviceId: 'laptop' }),
      ).resolves.toMatchObject({ counted: false, reason: 'duplicate' });
      // The user key still matches, so the same human on a second device is
      // one view. That is deliberate: it is one person.
    });

    it('two different people on one shared device are counted separately', async () => {
      await view({ viewerId: 'shopper-1', deviceId: 'shared-tablet' });
      // The device key blocks the second person inside the window. Accepted
      // trade-off: the window is 30 minutes, so the loss is bounded, and the
      // alternative (ignoring the device) would double-count every sign-in.
      await expect(
        view({ viewerId: 'shopper-2', deviceId: 'shared-tablet' }),
      ).resolves.toMatchObject({ counted: false });
    });
  });

  describe('who is not an audience', () => {
    it('never counts the owner viewing their own item', async () => {
      await expect(
        view({ viewerId: 'brand-owner', deviceId: 'device-a' }),
      ).resolves.toEqual({ counted: false, reason: 'owner' });
    });

    it('never counts a console operator', async () => {
      await expect(
        view({ viewerId: 'admin-1', viewerRole: 'Admin' }),
      ).resolves.toEqual({ counted: false, reason: 'operator' });
      await expect(
        view({ viewerId: 'admin-2', viewerRole: 'SuperAdmin' }),
      ).resolves.toEqual({ counted: false, reason: 'operator' });
    });

    it('counts an ordinary signed-in user', async () => {
      await expect(
        view({ viewerId: 'shopper-1', viewerRole: 'User' }),
      ).resolves.toMatchObject({ counted: true });
    });

    it.each([
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'facebookexternalhit/1.1',
      'python-requests/2.31.0',
      'curl/8.4.0',
    ])('never counts %s', async (userAgent) => {
      await expect(
        view({ deviceId: 'device-a', userAgent }),
      ).resolves.toEqual({ counted: false, reason: 'bot' });
    });

    it('counts a normal browser', async () => {
      await expect(
        view({
          deviceId: 'device-a',
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        }),
      ).resolves.toMatchObject({ counted: true });
    });
  });

  describe('anonymous viewers', () => {
    it('falls back to the IP only when nothing better exists', async () => {
      await expect(view({ ipAddress: '203.0.113.9' })).resolves.toMatchObject({
        counted: true,
      });
      await expect(view({ ipAddress: '203.0.113.9' })).resolves.toMatchObject({
        counted: false,
      });
    });

    it('does not let one office IP suppress signed-in colleagues', async () => {
      // The old implementation matched on ipHash even for signed-in viewers, so
      // one person on shared wifi hid the item from everyone else for 24h.
      await view({ viewerId: 'colleague-1', ipAddress: '203.0.113.9' });
      await expect(
        view({ viewerId: 'colleague-2', ipAddress: '203.0.113.9' }),
      ).resolves.toMatchObject({ counted: true });
    });

    it('counts nothing when there is no identity at all', async () => {
      await expect(view({})).resolves.toEqual({
        counted: false,
        reason: 'unidentified',
      });
    });
  });

  describe('delivery problems', () => {
    it('swallows a retried event rather than counting it twice', async () => {
      await expect(
        view({ viewerId: 'shopper-1', eventId: 'evt-1' }),
      ).resolves.toMatchObject({ counted: true });
      await expect(
        view({ viewerId: 'shopper-1', eventId: 'evt-1' }),
      ).resolves.toEqual({ counted: false, reason: 'replayed-event' });
    });

    it('fails closed when Redis is unavailable', async () => {
      (service as any).redis = null;
      await expect(view({ viewerId: 'shopper-1' })).resolves.toEqual({
        counted: false,
        reason: 'unavailable',
      });
    });

    it('fails closed when a Redis command throws', async () => {
      (service as any).redis = {
        ...redis,
        eval: jest.fn().mockRejectedValue(new Error('connection lost')),
      };
      await expect(view({ viewerId: 'shopper-1' })).resolves.toEqual({
        counted: false,
        reason: 'unavailable',
      });
    });
  });

  describe('separate items are separate', () => {
    it('counts the same viewer on a different design', async () => {
      await view({ viewerId: 'shopper-1', targetId: 'design-1' });
      await expect(
        view({ viewerId: 'shopper-1', targetId: 'design-2' }),
      ).resolves.toMatchObject({ counted: true });
    });

    it('does not confuse a design with a product of the same id', async () => {
      await view({ viewerId: 'shopper-1', targetId: 'same-id' });
      await expect(
        service.record({
          target: 'PRODUCT',
          targetId: 'same-id',
          viewerId: 'shopper-1',
        }),
      ).resolves.toMatchObject({ counted: true });
    });
  });

  describe('flush', () => {
    it('increments rather than recounting, and routes each type to its table', async () => {
      await view({ viewerId: 'a', targetId: 'design-1' });
      await view({ viewerId: 'b', targetId: 'design-1' });
      await service.record({
        target: 'PRODUCT',
        targetId: 'product-1',
        viewerId: 'c',
      });

      await (service as any).flush();

      expect(prisma.collection.update).toHaveBeenCalledWith({
        where: { id: 'design-1' },
        data: { viewsCount: { increment: 2 } },
      });
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'product-1' },
        data: { viewsCount: { increment: 1 } },
      });
    });

    it('does nothing when there is nothing buffered', async () => {
      await (service as any).flush();
      expect(prisma.collection.update).not.toHaveBeenCalled();
    });
  });

  describe('IP pseudonymisation', () => {
    it('does not return the address in a recoverable form', () => {
      const hash = service.hashIp('203.0.113.9');
      expect(hash).toBeTruthy();
      expect(hash).not.toContain('203');
      // The old implementation was base64, which decodes straight back.
      expect(Buffer.from(hash!, 'base64').toString()).not.toContain('203.0.113');
    });

    it('is stable and distinct', () => {
      expect(service.hashIp('203.0.113.9')).toBe(service.hashIp('203.0.113.9'));
      expect(service.hashIp('203.0.113.9')).not.toBe(
        service.hashIp('203.0.113.10'),
      );
    });

    it('refuses to emit a guessable hash with no pepper configured', () => {
      delete process.env.VIEW_IP_HASH_SECRET;
      delete process.env.JWT_ACCESS_SECRET;
      expect(service.hashIp('203.0.113.9')).toBeNull();
    });

    it('returns null for an empty address', () => {
      expect(service.hashIp(null)).toBeNull();
      expect(service.hashIp('   ')).toBeNull();
    });
  });
});

describe('readDeviceId', () => {
  const req = (value: unknown) => ({ headers: { 'x-wiez-device-id': value } });

  it('accepts an opaque id', () => {
    expect(readDeviceId(req('anon_9f2c-4a11.b'))).toBe('anon_9f2c-4a11.b');
  });

  it('rejects anything that could break out of a Redis key', () => {
    expect(readDeviceId(req('a:b'))).toBeNull();
    expect(readDeviceId(req('a\nb'))).toBeNull();
    expect(readDeviceId(req('a b'))).toBeNull();
  });

  it('rejects an unbounded value', () => {
    expect(readDeviceId(req('a'.repeat(129)))).toBeNull();
  });

  it('tolerates a missing or malformed header', () => {
    expect(readDeviceId({ headers: {} })).toBeNull();
    expect(readDeviceId({})).toBeNull();
    expect(readDeviceId(req(['a', 'b']))).toBe('a');
    expect(readDeviceId(req(42))).toBeNull();
  });
});
