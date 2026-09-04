import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `/designs/*` is a FACADE over the collections domain, and must stay one.
 *
 * A design and a "design collection" are the same `Collection` row. Two route
 * families serve it — web reads `/collections/:id`, native reads `/designs/:id`
 * — and that split has already cost real behaviour: view counting was added to
 * the collections route only, so every design opened in the native app counted
 * for nothing until it was noticed by hand.
 *
 * The routes cannot simply be merged: native builds already installed call
 * `/designs/*`, and deleting it would break them in the field. What CAN be
 * guaranteed is that the facade never grows its own logic — as long as every
 * method delegates, cross-cutting behaviour added in `CollectionsService`
 * reaches both clients automatically and the two cannot drift.
 *
 * This is the enforceable half of convergence. The other half — retiring one
 * route family once native adoption allows — is a product decision, not a
 * test.
 */
const source = readFileSync(
  join(__dirname, 'designs.service.ts'),
  'utf8',
);

/** Method bodies, keyed by name, from the class body. */
function methodBodies(text: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const signature = /^ {2}(?:private |public )?async ([A-Za-z0-9_]+)\(/gm;
  let match: RegExpExecArray | null;

  while ((match = signature.exec(text))) {
    const name = match[1];

    // Walk the parameter list to its closing paren FIRST. Several methods take
    // an inline object type (`body: { deviceName?: string }`), so the next `{`
    // after the method name belongs to a parameter, not the body — reading
    // from there captures the type annotation instead of the implementation
    // and reports a delegating method as an offender.
    let parenDepth = 1;
    let cursor = signature.lastIndex;
    while (cursor < text.length && parenDepth > 0) {
      if (text[cursor] === '(') parenDepth += 1;
      else if (text[cursor] === ')') parenDepth -= 1;
      cursor += 1;
    }

    const bodyStart = text.indexOf('{', cursor);
    if (bodyStart < 0) continue;
    let depth = 0;
    let end = bodyStart;
    for (let i = bodyStart; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    bodies.set(name, text.slice(bodyStart, end + 1));
  }

  return bodies;
}

/**
 * The one method that legitimately does not touch CollectionsService: custom
 * order configuration is its own domain with its own service, not collections
 * behaviour wearing a design name.
 */
const DELEGATES_ELSEWHERE = new Set([
  'getDesignCustomOrderConfiguration',
  'submitDesignCustomFitInquiry',
]);

describe('DesignsService is a facade, not a second implementation', () => {
  const bodies = methodBodies(source);

  it('finds the service methods', () => {
    expect(bodies.size).toBeGreaterThan(15);
    expect(bodies.has('getDesignDetail')).toBe(true);
  });

  it('every method delegates rather than reimplementing', () => {
    const offenders: string[] = [];

    for (const [name, body] of bodies) {
      if (DELEGATES_ELSEWHERE.has(name)) continue;
      const delegates =
        body.includes('this.collectionsService.') ||
        body.includes('this.customOrderConfigurationsService.');
      if (!delegates) offenders.push(name);
    }

    expect({ offenders }).toEqual({ offenders: [] });
  });

  it('never reaches the database directly', () => {
    // A Prisma call here would be logic that `/collections/*` does not have,
    // which is exactly how the two route families come apart.
    expect(source).not.toMatch(/this\.prisma\./);
    expect(source).not.toMatch(/PrismaService/);
  });

  it('getDesignDetail forwards the view context to the shared read', () => {
    const body = bodies.get('getDesignDetail') ?? '';
    expect(body).toContain('this.collectionsService.getCollection(');
    // Without this the native route reads the design and counts nothing.
    expect(body).toContain('viewContext');
  });
});
