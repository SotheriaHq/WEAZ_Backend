import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The guard that would have caught the nine-day worker crash loop.
 *
 * Between 2026-08-15 and 2026-08-24 the SIT worker restarted 74,771 times with
 * "Cannot access 'StoreModule' before initialization". Nothing in CI failed:
 * a NestJS module cycle without `forwardRef` is valid TypeScript, passes lint,
 * compiles, and only throws at boot — and only for whichever entry point loads
 * the graph first, which is why `main.ts` was fine while `worker.ts` died.
 *
 * These fixtures pin the two judgements that matter, because getting either
 * wrong makes the guard worse than useless: a false negative restores the
 * original blind spot, and a false positive teaches people to skip the check.
 */

const CHECKER = path.join(__dirname, 'check-module-cycles.js');

/** Runs the real script against a throwaway tree. */
function check(modules: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cycles-'));
  try {
    for (const [name, source] of Object.entries(modules)) {
      fs.writeFileSync(path.join(root, name), source);
    }
    try {
      const stdout = execFileSync(process.execPath, [CHECKER, root], {
        encoding: 'utf8',
      });
      return { code: 0, output: stdout };
    } catch (error: any) {
      return {
        code: error.status as number,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const mod = (name: string, imports: string) =>
  `import { Module, forwardRef } from '@nestjs/common';
@Module({ imports: [${imports}] })
export class ${name} {}`;

describe('check-module-cycles', () => {
  it('passes a graph with no cycles', () => {
    const result = check({
      'a.module.ts': mod('AModule', 'BModule'),
      'b.module.ts': mod('BModule', ''),
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('OK');
  });

  it('fails a two-module cycle with no forwardRef', () => {
    const result = check({
      'a.module.ts': mod('AModule', 'BModule'),
      'b.module.ts': mod('BModule', 'AModule'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('forwardRef(() => BModule)');
  });

  it('passes a two-module cycle deferred on both sides', () => {
    const result = check({
      'a.module.ts': mod('AModule', 'forwardRef(() => BModule)'),
      'b.module.ts': mod('BModule', 'forwardRef(() => AModule)'),
    });

    expect(result.code).toBe(0);
  });

  it('fails the three-module ring that killed the worker, even with ONE forwardRef', () => {
    /*
      The real shape on 2026-08-15. `CategoriesModule -> CollectionsModule` was
      already deferred and the worker still died on every boot, because the edge
      that throws is whichever BARE one closes the require chain — and which one
      that is depends on the entry point. "One forwardRef in the ring is enough"
      is the belief this test exists to kill.
    */
    const result = check({
      'store.module.ts': mod('StoreModule', 'CategoriesModule'),
      'categories.module.ts': mod(
        'CategoriesModule',
        'forwardRef(() => CollectionsModule)',
      ),
      'collections.module.ts': mod('CollectionsModule', 'StoreModule'),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('forwardRef(() => CategoriesModule)');
    expect(result.output).toContain('forwardRef(() => StoreModule)');
  });

  it('passes that same ring once every bare edge is deferred', () => {
    const result = check({
      'store.module.ts': mod('StoreModule', 'forwardRef(() => CategoriesModule)'),
      'categories.module.ts': mod(
        'CategoriesModule',
        'forwardRef(() => CollectionsModule)',
      ),
      'collections.module.ts': mod(
        'CollectionsModule',
        'forwardRef(() => StoreModule)',
      ),
    });

    expect(result.code).toBe(0);
  });

  it('ignores a commented-out import rather than reporting a phantom cycle', () => {
    // A false positive here would send someone hunting a cycle that does not
    // exist, and the next person would disable the check.
    const result = check({
      'a.module.ts': mod('AModule', 'BModule'),
      'b.module.ts': `import { Module } from '@nestjs/common';
@Module({ imports: [/* AModule, */] })
export class BModule {}`,
    });

    expect(result.code).toBe(0);
  });

  it('reports the live repository as clean', () => {
    // Guards the guard: if src/ ever regresses, this fails here as well as in CI.
    const result = check({});
    const real = execFileSync(process.execPath, [CHECKER], { encoding: 'utf8' });

    expect(result.code).toBe(0);
    expect(real).toContain('every edge in a cycle deferred');
  });
});
