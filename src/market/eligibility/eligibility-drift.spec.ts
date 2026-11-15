import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

// These are writes, commercial-action checks, and an existing display default;
// none is a public discovery query. Newly introduced copies require review.
const allowed = new Set([
  'src/store/store.service.ts:handleScheduledProductPublishNotifications',
  'src/store/store.service.ts:createProductWithContext',
  'src/store/store.service.ts:submitProductForReview',
  'src/store/store.service.ts:updateProductWithContext',
  'src/store/store.service.ts:handleBagCheckoutReminders',
  'src/store/store.service.ts:addToCart',
  'src/store/store.service.ts:addToWishlist',
  'src/store/store.service.ts:transformProduct',
]);

function findCopies(filename: string, text: string): string[] {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const copies: string[] = [];
  const walk = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source).replace(/["']/g, '') === 'publicationStatus' &&
      /(?:PUBLISHED|DRAFT|IN_REVIEW)/.test(node.initializer.getText(source))
    ) {
      let owner: ts.Node | undefined = node.parent;
      while (
        owner &&
        !ts.isMethodDeclaration(owner) &&
        !ts.isFunctionDeclaration(owner)
      )
        owner = owner.parent;
      const name =
        owner &&
        (ts.isMethodDeclaration(owner) || ts.isFunctionDeclaration(owner))
          ? owner.name?.getText(source)
          : '<top-level>';
      const key = `${filename}:${name}`;
      // Draft lifecycle writes are outside public retrieval. PUBLISHED copies
      // are checked individually rather than exempting the whole Store file.
      if (
        /PUBLISHED/.test(node.initializer.getText(source)) &&
        !allowed.has(key)
      )
        copies.push(key);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return copies;
}

describe('public discovery policy drift', () => {
  it('rejects newly copied publication predicates outside the canonical module', () => {
    const copies: string[] = [];
    for (const directory of ['src/market', 'src/search', 'src/store']) {
      for (const entry of fs.readdirSync(directory, {
        recursive: true,
      }) as string[]) {
        const name = `${directory}/${entry.replace(/\\/g, '/')}`;
        if (
          !name.endsWith('.ts') ||
          name.endsWith('.spec.ts') ||
          name.includes('/eligibility/')
        )
          continue;
        copies.push(
          ...findCopies(name, fs.readFileSync(path.resolve(name), 'utf8')),
        );
      }
    }
    expect(copies).toEqual([]);
  });

  it('detects a deliberate negative-control copy in a new service', () => {
    expect(
      findCopies(
        'src/market/new-source.ts',
        'class NewSource { query() { return { publicationStatus: "PUBLISHED" }; } }',
      ),
    ).toEqual(['src/market/new-source.ts:query']);
  });

  it.each([
    ['src/market/market-section.service.ts', 'eligibleProductWhere'],
    ['src/market/market-suggestion.service.ts', 'eligibleProductWhere'],
    ['src/store/store.service.ts', 'isEligibleProduct'],
    ['src/search/core/search-visibility.service.ts', 'eligibleProductWhere'],
    ['src/search/search.service.ts', 'eligibleProductSql'],
    ['src/collections/collections.service.ts', 'eligibleStoreCollectionWhere'],
    ['src/common/content-audience.ts', 'isEligibleProduct'],
    [
      'src/admin/featured/public-featured-summary.util.ts',
      'eligibleProductWhere',
    ],
  ])('keeps the public consumer %s connected to %s', (filename, symbol) => {
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let calls = 0;
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === symbol
      )
        calls++;
      ts.forEachChild(node, walk);
    };
    walk(source);
    expect(calls).toBeGreaterThan(0);
  });
});
