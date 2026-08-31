import { ProductViewCounterService } from './product-view-counter.service';

/**
 * Shutdown must never produce an unhandled rejection.
 *
 * The bug: `closeRedisClient` called `client.disconnect()` inside a SYNCHRONOUS
 * `try/catch`. node-redis returns a Promise from `disconnect()` and rejects with
 * `ClientClosedError` when the socket is already closed, so the `catch` never
 * fired and the rejection escaped the call stack entirely.
 *
 * That is invisible in the API, where main.ts installs an `unhandledRejection`
 * handler that logs and continues. In the worker, which installs none, it was
 * fatal — and fatal at the worst moment: `onModuleDestroy` rejected, so
 * `app.close()` never resolved, `process.exit(0)` never ran, and PM2 fell back
 * to SIGKILL. Every entry in pm2.log for both processes reads "exited with code
 * [0] via signal [SIGKILL]" for this reason, which also means BullMQ jobs in
 * flight were killed rather than drained on every deploy.
 *
 * These tests assert the property rather than the implementation: teardown
 * settles, and nothing escapes. `disconnect()` is deliberately given a REJECTED
 * promise, which is exactly what the real client returns and exactly what the
 * old code could not catch.
 */

type Harness = {
  service: ProductViewCounterService;
  client: {
    isOpen: boolean;
    quit: jest.Mock;
    disconnect: jest.Mock;
    removeAllListeners: jest.Mock;
  };
};

/** A service holding a fake client, with the DB write path stubbed out. */
function harness(overrides: Partial<Harness['client']> = {}): Harness {
  const client = {
    isOpen: true,
    quit: jest.fn().mockResolvedValue(undefined),
    // Rejects, like the real one does on an already-closed socket.
    disconnect: jest
      .fn()
      .mockRejectedValue(new Error('The client is closed')),
    removeAllListeners: jest.fn(),
    ...overrides,
  };

  const service = new ProductViewCounterService({} as any);
  // The Redis handle is private and only ever set by a successful connect();
  // reaching in is the only way to test teardown without a live server.
  (service as any).redis = client;
  (service as any).flush = jest.fn().mockResolvedValue(undefined);

  return { service, client };
}

describe('ProductViewCounterService — shutdown', () => {
  let unhandled: unknown[];
  const record = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
  });

  /** Rejections surface a turn later; this lets them land before we assert. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('closes an open client and resolves', async () => {
    const { service, client } = harness();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    await settle();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('does not reject when quit() fails', async () => {
    const { service } = harness({
      quit: jest.fn().mockRejectedValue(new Error('socket gone')),
    });

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    await settle();

    expect(unhandled).toEqual([]);
  });

  it('leaks nothing when the client is ALREADY closed — the exact crash', async () => {
    // `isOpen: false` was the old `else` branch: a bare `client.disconnect()`
    // whose rejected promise no synchronous catch could ever see.
    const { service, client } = harness({ isOpen: false });

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    await settle();

    expect(client.quit).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('survives a double shutdown, as a second signal would cause', async () => {
    const { service } = harness({ isOpen: false });

    await service.onModuleDestroy();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    await settle();

    expect(unhandled).toEqual([]);
  });
});
