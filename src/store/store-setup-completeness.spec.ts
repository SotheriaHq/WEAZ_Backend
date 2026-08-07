import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * "Store setup is complete" must mean ONE thing.
 *
 * It did not. `StoreService.computeStoreCompleteness` (which gates publishing
 * and studio access) omitted business hours, while
 * `BrandVerificationService.getStoreReadiness` (which gates verification)
 * required them. A brand could therefore finish every setup screen, publish,
 * get full studio access — and then be told at the verification gate that its
 * store was incomplete, naming a requirement no setup screen had ever asked
 * for. Nothing failed loudly; the two lists just disagreed.
 *
 * These tests re-derive both lists from source and assert they still agree.
 */

const read = (...segments: string[]) =>
  readFileSync(join(__dirname, ...segments), 'utf8');

/**
 * Slice out a single method body.
 *
 * Deliberately NOT brace-matching: both of these methods declare object types in
 * their signature (`brand: {`, `Promise<{`), so counting from the first `{`
 * closes on the type annotation and returns a body containing none of the
 * pushes we came to read — which silently passes as "no codes found" rather
 * than failing. Class methods here are indented two spaces, so the body runs to
 * the first line that is exactly `  }`.
 */
const methodBody = (source: string, signature: string): string => {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Could not find "${signature}" — did it get renamed?`);
  }
  const lines = source.slice(start).split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line === '  }');
  if (end === -1) {
    throw new Error(`Could not find the end of "${signature}"`);
  }
  return lines.slice(0, end + 1).join('\n');
};

const matchAll = (body: string, pattern: RegExp): string[] =>
  Array.from(body.matchAll(pattern)).map((match) => match[1]);

describe('store setup completeness', () => {
  const storeSource = read('store.service.ts');
  const verificationSource = read(
    '..',
    'brand-verification',
    'brand-verification.service.ts',
  );

  const completenessBody = methodBody(
    storeSource,
    'private computeStoreCompleteness(',
  );
  const readinessBody = methodBody(verificationSource, 'async getStoreReadiness(');

  const completenessCodes = new Set(
    matchAll(completenessBody, /missingFields\.push\('([^']+)'\)/g),
  );
  const readinessCodes = new Set(matchAll(readinessBody, /code: '([^']+)'/g));

  it('publish/studio and verification agree on which fields are required', () => {
    // `publish` is not a field — it is the act of publishing, which the store
    // side tracks separately as `storePublishedAt` alongside this list
    // (`isSetupComplete = isComplete && Boolean(storePublishedAt)`).
    const expected = new Set(readinessCodes);
    expected.delete('publish');

    expect([...completenessCodes].sort()).toEqual([...expected].sort());
  });

  it('requires business hours on both sides', () => {
    // The specific field that drifted. Called out on its own so a regression
    // names the actual cause rather than just "sets differ".
    expect(completenessCodes.has('businessHours')).toBe(true);
    expect(readinessCodes.has('businessHours')).toBe(true);
  });

  it('defaults the working-hours requirement to on', () => {
    // Shipped opt-in via env and then never enabled anywhere, so the client hard
    // gate stayed inert and nothing collected hours until the verification gate
    // refused. Opting OUT must be the explicit choice.
    expect(storeSource).toMatch(
      /process\.env\.STORE_WORKING_HOURS_REQUIRED \?\? 'true'/,
    );
  });

  it('points every outstanding step at a route that exists', () => {
    // These hrefs are rendered as real links by the verification banner.
    // `/studio/store/hours` and `/studio/store/payments` were never registered
    // in the web router, so "Fix →" led to the catch-all 404. Keep this list in
    // sync with fthreadly `src/App.tsx`.
    const REAL_ROUTES = [
      '/studio/store/setup',
      '/studio/store/essentials',
      '/settings?tab=store-hours',
      '/settings?tab=billing',
    ];

    const hrefs = matchAll(readinessBody, /href: '([^']+)'/g);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(REAL_ROUTES).toContain(href);
    }
  });
});
