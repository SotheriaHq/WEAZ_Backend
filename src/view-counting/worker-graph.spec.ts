import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `@Global()` scopes a provider to the application graph that imports it, not
 * to the process. The API boots `AppModule` and the worker boots
 * `QueueWorkerModule`, so a global module registered in one is simply absent
 * from the other — and a service that injects it fails the worker at boot with
 * an unresolved dependency.
 *
 * That is not a hypothetical: it is the failure class behind the worker's
 * 74,771 restarts, and adding ViewCountingService to StoreService and
 * CollectionsService reintroduced it until QueueWorkerModule was updated too.
 *
 * A static check rather than a compiled Nest graph: compiling
 * QueueWorkerModule needs a live database and Redis, so it cannot run in unit
 * CI — which is precisely why the original break reached SIT.
 */
const readModule = (relativePath: string) =>
  readFileSync(join(__dirname, '..', relativePath), 'utf8');

const importsModule = (source: string, moduleName: string) => {
  const importsBlock = source.match(/imports:\s*\[/);
  if (!importsBlock) return false;
  // Anywhere in the decorator is good enough — the concern is presence, and a
  // module named in `providers` instead would not compile.
  return new RegExp(`\\b${moduleName}\\b`).test(source);
};

describe('worker dependency graph', () => {
  const appModule = readModule('app.module.ts');
  const workerModule = readModule('queue/queue-worker.module.ts');

  it('the API graph has ViewCountingModule', () => {
    expect(importsModule(appModule, 'ViewCountingModule')).toBe(true);
  });

  it('the worker graph has ViewCountingModule', () => {
    // QueueWorkerModule imports StoreModule and provides CollectionsService
    // directly; both inject ViewCountingService.
    expect(importsModule(workerModule, 'ViewCountingModule')).toBe(true);
  });

  it('any graph carrying StoreModule or CollectionsService also carries ViewCountingModule', () => {
    for (const [name, source] of [
      ['app.module.ts', appModule],
      ['queue/queue-worker.module.ts', workerModule],
    ] as const) {
      const needsIt =
        /\bStoreModule\b/.test(source) || /\bCollectionsService\b/.test(source);
      if (!needsIt) continue;
      expect({ module: name, hasViewCounting: importsModule(source, 'ViewCountingModule') })
        .toEqual({ module: name, hasViewCounting: true });
    }
  });
});
