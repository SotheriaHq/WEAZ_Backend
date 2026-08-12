import { CollectionStatus } from '@prisma/client';

/**
 * Which statuses a finalize/publish may start from.
 *
 * The gate this covers used to read "is it DRAFT? then PUBLISHED? otherwise
 * reject", which silently made every review state unpublishable. A design in
 * CHANGES_REQUESTED is precisely the case where the owner has done the work a
 * reviewer asked for and needs to send it back — and it was the one case that
 * returned 400 ("Collection is not in draft status").
 *
 * Mirrors `RESUBMITTABLE_COLLECTION_STATUSES` in collections.service.ts. Kept as
 * an explicit table so adding a status to the enum without deciding whether it
 * can be resubmitted shows up as a failing test rather than a 400 in the field.
 */
const EXPECTED_RESUBMITTABLE: CollectionStatus[] = [
  CollectionStatus.CHANGES_REQUESTED,
  CollectionStatus.REJECTED,
  CollectionStatus.FAILED,
  CollectionStatus.IN_REVIEW,
];

const EXPECTED_BLOCKED: CollectionStatus[] = [
  CollectionStatus.ARCHIVED,
  CollectionStatus.REMOVED,
  CollectionStatus.PROCESSING,
];

describe('collection resubmission statuses', () => {
  // Read the set straight out of the service source: importing the service
  // drags in the whole Nest dependency graph, and what matters here is the
  // decision table, not the wiring.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, 'collections.service.ts'),
    'utf8',
  ) as string;

  const declared = (() => {
    const match = source.match(
      /RESUBMITTABLE_COLLECTION_STATUSES = new Set<CollectionStatus>\(\[([\s\S]*?)\]\)/,
    );
    if (!match) throw new Error('RESUBMITTABLE_COLLECTION_STATUSES not found');
    return [...match[1].matchAll(/CollectionStatus\.(\w+)/g)].map((m) => m[1]);
  })();

  it.each(EXPECTED_RESUBMITTABLE)('allows a resubmit from %s', (status) => {
    expect(declared).toContain(status);
  });

  it.each(EXPECTED_BLOCKED)('does not allow a publish from %s', (status) => {
    expect(declared).not.toContain(status);
  });

  it('never treats DRAFT or PUBLISHED as resubmittable — they have their own branches', () => {
    expect(declared).not.toContain(CollectionStatus.DRAFT);
    expect(declared).not.toContain(CollectionStatus.PUBLISHED);
  });

  it('covers every status in the enum exactly once across the decision table', () => {
    const accountedFor = new Set<string>([
      ...declared,
      ...EXPECTED_BLOCKED,
      CollectionStatus.DRAFT,
      CollectionStatus.PUBLISHED,
    ]);
    for (const status of Object.values(CollectionStatus)) {
      expect(accountedFor.has(status)).toBe(true);
    }
  });

  it('applies the same gate to store collections', () => {
    // Store collections share CollectionStatus and the same review lifecycle,
    // so they carried the identical bug.
    const storeGate = source.match(
      /const storeStatus = collection\.status as CollectionStatus;[\s\S]{0,2000}?RESUBMITTABLE_COLLECTION_STATUSES\.has\(storeStatus\)/,
    );
    expect(storeGate).not.toBeNull();
  });

  it('no longer THROWS "not in draft status" for a review state', () => {
    // Comments are stripped first: the phrase survives in a note explaining the
    // old behaviour, and what must be gone is the statement that raised it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(
      /throw new BadRequestException\(\s*'Collection is not in draft status'/,
    );
    // …and the phrase is still documented somewhere, so the fix stays legible.
    expect(source).toContain('Collection is not in draft status');
  });
});
