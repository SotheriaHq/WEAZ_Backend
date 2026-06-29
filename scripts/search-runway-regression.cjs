#!/usr/bin/env node
/**
 * SEARCH-CORE-4/5 search + Runway pinned-feed regression.
 *
 * Live API smoke that guards the high-value contracts:
 *   - Search Core relevance (avery cotour fixed, Jaff products excluded).
 *   - Default Runway feed shape unchanged.
 *   - Runway search-pinned feed: safe shape, anchor-first, keyset pagination,
 *     and clean exhaustion on empty/no-match queries.
 *
 * Resilient to sparse local data: a real design is discovered from the default
 * feed and reused as the known-query/anchor. If the DB has no public designs,
 * the design-dependent checks are reported as skipped rather than failing.
 *
 * Usage: node scripts/search-runway-regression.cjs [baseUrl]
 *   baseUrl defaults to http://127.0.0.1:3040
 */
const http = require('http');
const https = require('https');

const BASE = (process.argv[2] || 'http://127.0.0.1:3040').replace(/\/$/, '');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function get(pathname) {
  const url = `${BASE}${pathname}`;
  const client = url.startsWith('https') ? https : http;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    client
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            ms: Date.now() - startedAt,
            json,
            data: json && 'data' in json ? json.data : json,
          });
        });
      })
      .on('error', reject);
  });
}

function check(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function skip(label, reason) {
  skipped += 1;
  console.log(`  SKIP  ${label} (${reason})`);
}

async function run() {
  console.log(`SEARCH-CORE-4/5 regression against ${BASE}\n`);

  // ---- Search Core relevance ----
  console.log('Search Core relevance:');
  const avery = await get('/v1/search?q=avery%20cotour');
  const averyItems = avery.data?.items ?? [];
  check('GET /v1/search?q=avery cotour -> 200', avery.status === 200);
  check(
    'avery cotour: first result is a profile (identity-first)',
    averyItems[0]?.type === 'profile',
  );
  check(
    'avery cotour: zero product results (distinctive-token gate holds)',
    (avery.data?.counts?.product ?? 0) === 0,
  );
  check(
    'avery cotour: zero brand results',
    (avery.data?.counts?.brand ?? 0) === 0,
  );

  const jaff = await get('/v1/search?q=jaff%20view');
  check('GET /v1/search?q=jaff view -> 200', jaff.status === 200);
  check(
    'jaff view: returns at least one result',
    (jaff.data?.items?.length ?? 0) > 0,
  );

  const noMatch = await get('/v1/search?q=zzzznomatchweaz');
  check('GET /v1/search?q=zzzznomatchweaz -> 200', noMatch.status === 200);
  check(
    'zzzznomatchweaz: empty results',
    (noMatch.data?.items?.length ?? 0) === 0,
  );

  const suggest = await get('/v1/search/suggest?q=avery%20cotour');
  check('GET /v1/search/suggest?q=avery cotour -> 200', suggest.status === 200);
  check(
    'suggest avery cotour: zero product suggestions',
    (suggest.data?.products?.total ?? 0) === 0,
  );

  // ---- Default Runway feed unchanged ----
  console.log('\nDefault Runway feed:');
  const def = await get('/collections/market?limit=10');
  check('GET /collections/market -> 200', def.status === 200);
  check(
    'default feed shape unchanged (items/hasNextPage/nextCursor only)',
    def.data &&
      'items' in def.data &&
      'hasNextPage' in def.data &&
      'nextCursor' in def.data &&
      !('feedMode' in def.data),
  );

  const defExplicit = await get('/collections/market?feedMode=default&limit=10');
  check(
    'feedMode=default behaves like default feed',
    defExplicit.status === 200 && !('feedMode' in (defExplicit.data ?? {})),
  );

  // Discover a real design to drive design-dependent checks.
  const sampleDesign = (def.data?.items ?? [])[0] ?? null;
  const designId = sampleDesign?.designId ?? null;
  const designTitle = (sampleDesign?.title ?? '').trim();
  const knownQuery = designTitle || 'adire';

  // ---- Runway search-pinned feed ----
  console.log('\nRunway search-pinned feed:');
  const pinnedShapeKeys = [
    'feedMode',
    'query',
    'items',
    'nextCursor',
    'hasMore',
    'anchorIncluded',
    'exhaustedReason',
    'searchContext',
    'routeHints',
  ];

  const empty = await get(
    '/collections/market?feedMode=searchPinned&query=&limit=10',
  );
  check('pinned empty query -> 200', empty.status === 200);
  check(
    'pinned empty query -> EMPTY_QUERY + no items',
    empty.data?.exhaustedReason === 'EMPTY_QUERY' &&
      (empty.data?.items?.length ?? 0) === 0,
  );
  check(
    'pinned response exposes the additive contract fields',
    pinnedShapeKeys.every((key) => key in (empty.data ?? {})),
  );

  const pinnedNoMatch = await get(
    '/collections/market?feedMode=searchPinned&query=zzzznomatchweaz&limit=10',
  );
  check('pinned no-match -> 200', pinnedNoMatch.status === 200);
  check(
    'pinned no-match -> hasMore=false + NO_MORE_MATCHES + empty',
    pinnedNoMatch.data?.hasMore === false &&
      pinnedNoMatch.data?.exhaustedReason === 'NO_MORE_MATCHES' &&
      (pinnedNoMatch.data?.items?.length ?? 0) === 0,
  );

  const badCursor = await get(
    '/collections/market?feedMode=searchPinned&query=adire&limit=10&cursor=garbage',
  );
  check(
    'pinned invalid cursor -> safe INVALID_CURSOR (no 500)',
    badCursor.status === 200 &&
      badCursor.data?.exhaustedReason === 'INVALID_CURSOR',
  );

  const badAnchor = await get(
    '/collections/market?feedMode=searchPinned&query=adire&anchorDesignId=not-a-uuid&limit=10',
  );
  check(
    'pinned malformed anchor -> safe (no 500, anchor not leaked)',
    badAnchor.status === 200 && badAnchor.data?.anchorIncluded === false,
  );

  if (!designId) {
    skip('pinned known-query returns the design', 'no public designs in DB');
    skip('pinned anchor-first ordering', 'no public designs in DB');
  } else {
    const pinned = await get(
      `/collections/market?feedMode=searchPinned&query=${encodeURIComponent(
        knownQuery,
      )}&limit=10`,
    );
    const ids = (pinned.data?.items ?? []).map((i) => i.designId);
    check(
      `pinned query "${knownQuery}" -> 200 and only DESIGN items`,
      pinned.status === 200 &&
        (pinned.data?.items ?? []).every((i) => i.entityType === 'DESIGN'),
    );
    check(
      `pinned query "${knownQuery}" includes discovered design`,
      ids.includes(designId),
    );

    const anchored = await get(
      `/collections/market?feedMode=searchPinned&query=${encodeURIComponent(
        knownQuery,
      )}&anchorDesignId=${designId}&limit=10`,
    );
    const anchoredIds = (anchored.data?.items ?? []).map((i) => i.designId);
    check(
      'pinned anchor appears first',
      anchored.data?.anchorIncluded === true &&
        anchoredIds[0] === designId,
    );
    check(
      'pinned anchor not duplicated later in the page',
      anchoredIds.filter((id) => id === designId).length === 1,
    );

    // Keyset pagination must not duplicate rows across pages.
    const page1 = await get(
      `/collections/market?feedMode=searchPinned&query=${encodeURIComponent(
        knownQuery,
      )}&limit=1`,
    );
    if (page1.data?.hasMore && page1.data?.nextCursor) {
      const page2 = await get(
        `/collections/market?feedMode=searchPinned&query=${encodeURIComponent(
          knownQuery,
        )}&limit=1&cursor=${encodeURIComponent(page1.data.nextCursor)}`,
      );
      const ids1 = new Set((page1.data.items ?? []).map((i) => i.designId));
      const dup = (page2.data?.items ?? []).filter((i) => ids1.has(i.designId));
      check('pinned keyset pagination: no duplicate rows across pages', dup.length === 0);
    } else {
      skip('pinned keyset pagination duplicate check', 'not enough matching designs');
    }
  }

  console.log(
    `\nDONE: ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  if (failed > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('Regression run errored:', error.message);
  console.error('Is the backend running on', BASE, '? Start it with: npm run dev');
  process.exit(2);
});
