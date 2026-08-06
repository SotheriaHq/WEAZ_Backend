import * as fs from 'fs';
import * as path from 'path';

/**
 * `AuthIntentGuard` is bound globally and fails CLOSED: a route handler that
 * declares neither `@UseGuards(...)` nor `@IsPublic()` is rejected with 401 for
 * *everyone*, including the user it was meant to serve.
 *
 * That is the intended security posture, but it turns a missing decorator into a
 * silent outage rather than a compile error. It has already cost us one: when the
 * guard landed, `GET /legal/versions` had no decorator, and because signup reads
 * the current legal document versions *before* the account exists, account
 * registration broke completely — the web form surfaced the 401 as an
 * "Authentication required" error pinned to the email field.
 *
 * This test re-derives that scan statically so the next missing decorator fails
 * CI instead of production. Adding a handler is fine; adding one without stating
 * its auth intent is not.
 */
describe('AuthIntentGuard route coverage', () => {
  const SRC = path.join(__dirname, '..', '..');

  function controllerFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist'].includes(entry.name)) {
          controllerFiles(full, out);
        }
      } else if (
        entry.name.endsWith('.controller.ts') &&
        !entry.name.includes('.spec.')
      ) {
        out.push(full);
      }
    }
    return out;
  }

  const HANDLER = /\n {2}((?:@[\w.]+(?:\([\s\S]*?\))?\s*\n\s*)+)(?:public\s+)?(?:async\s+)?(\w+)\s*\(/g;
  const HTTP_METHOD = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(/;
  const DECLARES_INTENT = /@UseGuards|@IsPublic/;

  it('every HTTP handler declares an auth intent (@UseGuards or @IsPublic)', () => {
    const offenders: string[] = [];

    for (const file of controllerFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      const controller = source.match(
        /((?:@[\w.]+\([\s\S]*?\)\s*\n)*)@Controller\(([^)]*)\)\s*\nexport class (\w+)/,
      );
      if (!controller) continue;

      // A class-level guard covers every handler inside it.
      if (DECLARES_INTENT.test(controller[1])) continue;

      const className = controller[3];
      const body = source.slice(controller.index! + controller[0].length);

      HANDLER.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = HANDLER.exec(body))) {
        const [, decorators, handlerName] = match;
        if (!HTTP_METHOD.test(decorators)) continue;
        if (DECLARES_INTENT.test(decorators)) continue;
        offenders.push(
          `${className}.${handlerName}()  [${path.relative(SRC, file)}]`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps signup reachable without a token', () => {
    // Guarding the specific regression: signup cannot complete if the legal
    // versions read requires the account that does not exist yet.
    const legal = fs.readFileSync(
      path.join(SRC, 'legal', 'legal.controller.ts'),
      'utf8',
    );
    expect(legal).toMatch(/@IsPublic\(\)\s*\n\s*@Get\('versions'\)/);
  });
});
