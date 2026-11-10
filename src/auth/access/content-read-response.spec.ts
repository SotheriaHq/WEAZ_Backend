import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { defer, firstValueFrom } from 'rxjs';
import { guardContentReadResponse } from './content-read-response';
import { readResourceContext, rememberReadResource } from './read-resource-context';
import { canViewContent } from 'src/common/content-audience';

describe('read resource request lifetime', () => {
  it('retains only the validated principal identity and clears it when the read ends', async () => {
    const user = { id: randomUUID(), role: 'User', accessToken: 'must-not-retain', securitySession: { private: true } };
    let scope: ReturnType<typeof readResourceContext.getStore>;
    await firstValueFrom(guardContentReadResponse(() => defer(async () => {
      scope = readResourceContext.getStore();
      expect(scope?.actor).toEqual({ id: user.id, role: user.role });
      expect(Object.isFrozen(scope?.actor)).toBe(true);
      return true;
    }), {} as any, async () => undefined, { user }, {}));
    expect(scope!.actor).toBeUndefined();
  });
  it('propagates through awaited domain checks and refuses private content after approval withdrawal', async () => {
    const id = randomUUID(), ownerId = randomUUID(), viewer = randomUUID();
    const prisma = { collection: { findUnique: jest.fn().mockResolvedValue({ ownerId, status: 'PUBLISHED', visibility: 'PRIVATE', deletedAt: null }),
      findMany: jest.fn().mockResolvedValue([{ id, ownerId, status: 'PUBLISHED', visibility: 'PRIVATE', deletedAt: null }]) },
      $queryRaw: jest.fn().mockResolvedValueOnce([{ viewerId: viewer, ownerId }]).mockResolvedValue([]) } as any;
    const actor = jest.fn();
    const read = defer(async () => {
      expect(await canViewContent(prisma, 'DESIGN', id, viewer)).toBe(true);
      return { private: 'must not emit' };
    });
    await expect(firstValueFrom(guardContentReadResponse(() => read, prisma, actor, {}, {}))).rejects.toMatchObject({ status: 403 });
    expect(actor).not.toHaveBeenCalled();
  });
  it('keeps concurrent request witnesses separate and closes even a detached continuation after abort', async () => {
    const request = new EventEmitter(), response = new EventEmitter(); let context: any;
    let resume!: () => void;
    const read = defer(async () => { context = readResourceContext.getStore(); await new Promise<void>(resolve => { resume = resolve; }); return 'body'; });
    const subscription = guardContentReadResponse(() => read, {} as any, async () => undefined, request, response).subscribe();
    expect(readResourceContext.getStore()).toBeUndefined();
    request.emit('aborted'); expect(context.open).toBe(false); expect(context.resources.size).toBe(0);
    expect(() => readResourceContext.run(context, () => rememberReadResource({ type: 'DESIGN', id: randomUUID() }))).toThrow('request ended');
    resume(); await Promise.resolve(); subscription.unsubscribe();
    expect(request.listenerCount('aborted')).toBe(0); expect(response.listenerCount('close')).toBe(0);
  });
  it('deduplicates witnesses and bounds memory without retaining resource data', () => {
    const scope = { open: true, resources: new Map() };
    readResourceContext.run(scope, () => {
      const resource = { type: 'DESIGN' as const, id: randomUUID() };
      for (let n = 0; n < 2000; n++) rememberReadResource(resource);
      expect(scope.resources.size).toBe(1);
      for (let n = 1; n < 1024; n++) rememberReadResource({ ...resource, id: randomUUID() });
      expect(() => rememberReadResource({ ...resource, id: randomUUID() })).toThrow('Too many access constraints');
    });
  });
});
