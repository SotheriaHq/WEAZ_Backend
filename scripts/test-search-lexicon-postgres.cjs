// Search quality proof (search spec section 7) on a disposable loopback
// database built by the real migrations: the real lexicon rebuilder, reader,
// parser and product search statement over a deterministic 10k catalogue.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');
const { Prisma, PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { emitDecoratorMetadata: false },
});
require('tsconfig-paths/register');
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const {
  SearchLexiconRebuilder,
} = require('../src/search/lexicon/search-lexicon.rebuilder');
const {
  SearchLexiconReader,
} = require('../src/search/lexicon/search-lexicon.reader');
const {
  SearchProductIntelligence,
  parseSearchProductRequest,
} = require('../src/search/intelligence/search-product.intelligence');
const {
  marketCatalogProductFiltersSql,
} = require('../src/market/catalog/market-filter.sql');
const {
  searchProductSql,
} = require('../src/search/intelligence/search-product.sql');
const {
  NAMED,
  fixtureId,
  seedCatalogue,
} = require('./lib/search-quality-fixture.cjs');

const CATALOGUE = Number(process.env.SEARCH_FIXTURE_PRODUCTS || 10000);
// Owner decision 26 Nov: p95 is measured and printed on every run; the 300 ms
// budget is enforced only when SEARCH_P95_BUDGET_MS is set (WP17 owns the
// remaining full-scan eligibility cost of attribute-only queries).
const LATENCY_P95_MS = process.env.SEARCH_P95_BUDGET_MS
  ? Number(process.env.SEARCH_P95_BUDGET_MS)
  : null;
const category = (slug) => `category:${fixtureId(`category:${slug}`)}`;
const type = (slug) => `garmentType:${fixtureId(`type:${slug}`)}`;
const brand = (name) => `brand:${fixtureId(`brand:${name}`)}`;
const dim = (dimension, value) => `dimension:${dimension}/${value}`;
const either = (...labels) => labels;
const fabric = (value) =>
  ['ankara', 'lace', 'adire', 'aso-oke', 'kente'].includes(value)
    ? either(dim('fabric', value), dim('heritage', value))
    : dim('fabric', value);
const agbada = either(category('agbada'), 'tag:agbada');

/** [query, expected attributes]; an array entry accepts any of its labels. */
const PARSE = [
  ['black evening dress', ['color:black', type('evening-gown')]],
  ['red maxi dress', ['color:red', type('maxi-dress')]],
  [
    "men's linen shirt",
    ['audience:MEN', fabric('linen'), category('tops-shirts')],
  ],
  ['white senator', ['color:white', category('senator-wear')]],
  ['gold agbada', ['color:gold', agbada]],
  ['lace buba and wrapper', [type('lace-buba-wrapper')]],
  ['iro and buba', [type('iro-and-buba')]],
  ['wedding kaftan', [dim('occasion', 'wedding'), category('kaftans')]],
  [
    'owambe party gown',
    [
      either(dim('occasion', 'owambe-party'), 'tag:owambe'),
      category('dresses-gowns'),
    ],
  ],
  ['ankara blazer', [fabric('ankara'), type('blazer')]],
  ['adire wrap skirt', [fabric('adire'), type('wrap-skirt')]],
  ['silk kimono', [fabric('silk'), type('kimono')]],
  ['velvet mermaid gown', [fabric('velvet'), type('mermaid-gown')]],
  ['chiffon midi dress', [fabric('chiffon'), type('midi-dress')]],
  ['aso oke agbada', [fabric('aso-oke'), agbada]],
  ['kente blazer', [fabric('kente'), type('blazer')]],
  ['denim jacket', [fabric('denim'), type('jacket')]],
  ['cotton joggers', [fabric('cotton'), type('joggers')]],
  ['satin crop top', [fabric('satin'), type('crop-top')]],
  ['organza bridal gown', [fabric('organza'), type('bridal-gown')]],
  ['emerald green kaftan', ['color:emerald green', category('kaftans')]],
  ['sky blue shorts', ['color:sky blue', type('shorts')]],
  ['navy three piece suit', ['color:navy', type('three-piece-suit')]],
  ['burgundy corset', ['color:burgundy', 'tag:corset']],
  ['wine gown', ['color:burgundy', category('dresses-gowns')]],
  // "Dashiki" alone is no lexicon term here (only "dashiki top/set"): text.
  ['purple dashiki', ['color:purple']],
  ["women's blazer", ['audience:WOMEN', type('blazer')]],
  ['unisex hoodie', ['audience:UNISEX', 'tag:hoodie']],
  ['ladies palazzo pants', ['audience:WOMEN', type('palazzo-pants')]],
  ['mens chinos', ['audience:MEN', type('chinos')]],
  ['agbada under 100k', [agbada, 'price:-100000']],
  ['dresses under ₦50,000', [category('dresses-gowns'), 'price:-50000']],
  ['senator wear below 80000', [category('senator-wear'), 'price:-80000']],
  ['kaftan over 100k', [category('kaftans'), 'price:100000-']],
  ['affordable kaftan', ['price:*', category('kaftans')]],
  ['luxury bridal gown', ['price:*', type('bridal-gown')]],
  ['cheap sneakers', ['price:*', 'tag:sneakers']],
  [
    'ready to wear gown',
    ['fulfilment:READY_TO_WEAR', category('dresses-gowns')],
  ],
  ['custom agbada', ['fulfilment:MADE_TO_ORDER', agbada]],
  ['bespoke suit', ['fulfilment:MADE_TO_ORDER', category('suits-blazers')]],
  ['blouse on sale', [type('blouse'), 'onSale:true']],
  ['discount kaftan', ['onSale:true', category('kaftans')]],
  ['sneakers size 42', ['tag:sneakers', 'size:42']],
  ['size m kaftan', ['size:M', category('kaftans')]],
  ['xl joggers', ['size:XL', type('joggers')]],
  ['uk 10 midi dress', ['size:UK 10', type('midi-dress')]],
  ['zuri threads', [brand('Zuri Threads')]],
  ['kosi couture gown', [brand('Kosi Couture'), category('dresses-gowns')]],
  ['lagos linen co shorts', [brand('Lagos Linen Co'), type('shorts')]],
  ['gele', ['tag:gele']],
  ['handbag', ['tag:handbag']],
  ['asoebi', [either('tag:asoebi', dim('heritage', 'aso-ebi'))]],
  ['jumpsuit', ['tag:jumpsuit']],
  ['graduation outfit', [dim('occasion', 'graduation')]],
  ['office wear women', [dim('occasion', 'office-work'), 'audience:WOMEN']],
  [
    'date night dress',
    [dim('occasion', 'date-night'), category('dresses-gowns')],
  ],
  ['minimalist blouse', [dim('style', 'minimalist'), type('blouse')]],
  ['vintage jacket', [dim('style', 'vintage-retro'), type('jacket')]],
  ['modest maxi skirt', [dim('style', 'modest'), type('maxi-skirt')]],
  ['naming ceremony agbada', [dim('occasion', 'naming-ceremony'), agbada]],
  ['birthday dress', [dim('occasion', 'birthday'), category('dresses-gowns')]],
  ['travel kimono', [dim('occasion', 'travel-vacation'), type('kimono')]],
  [
    'religious event senator',
    [dim('occasion', 'religious-event'), category('senator-wear')],
  ],
  ['statement blazer', [dim('style', 'statement-bold'), type('blazer')]],
  ['streetwear hoodie', [dim('style', 'casual-streetwear'), 'tag:hoodie']],
  [
    'corporate suit women',
    [
      dim('style', 'formal-corporate'),
      category('suits-blazers'),
      'audience:WOMEN',
    ],
  ],
];

/** [typo, the clean query it means]: one edit on a lexicon term. */
const TYPOS = [
  ['agbda', 'agbada'],
  ['kafatn', 'kaftan'],
  ['senetor', 'senator'],
  ['blazar', 'blazer'],
  ['kimomo', 'kimono'],
  ['jogers', 'joggers'],
  ['culotes', 'culottes'],
  ['chifon', 'chiffon'],
  ['velvat', 'velvet'],
  ['organze', 'organza'],
  ['dashki', 'dashiki'],
  ['burgandy', 'burgundy'],
  ['emrald green', 'emerald green'],
  ['palazo pants', 'palazzo pants'],
  ['corsett', 'corset'],
  ['sneekers', 'sneakers'],
  ['handbg', 'handbag'],
  ['jumsuit', 'jumpsuit'],
  ['graduaton', 'graduation'],
  ['minimalst', 'minimalist'],
  ['weding', 'wedding'],
  ['kentee', 'kente'],
  ['addire', 'adire'],
  ['shawll', 'shawl'],
  ['tuxdeo', 'tuxedo'],
  ['waistcot', 'waistcoat'],
  ['bodycn dress', 'bodycon dress'],
];

/** Queries the catalogue cannot satisfy; gibberish must return nothing. */
const UNSATISFIABLE = [
  ['qwertyuiop', true],
  ['zzzzqx', true],
  ['snowboard', false],
  ['scuba wetsuit', false],
  ['laptop charger', false],
  ['ski goggles', false],
  ['ballet tutu', false],
  ['iphone case', false],
  ['lawn mower', false],
  ['purple tuxedo size 50', false],
];

const SORTED = [
  ['red maxi dress', 'price_asc'],
  ['ankara blazer', 'price_desc'],
  ['silk kimono', 'newest'],
  ['kaftan over 100k', 'price_asc'],
  ['white senator', 'newest'],
  ['cotton joggers', 'price_desc'],
  ['gele', 'price_asc'],
  ['zuri threads', 'newest'],
  ['wedding kaftan', 'price_asc'],
  ['minimalist blouse', 'price_desc'],
  ['lagos linen co shorts', 'newest'],
  ['emerald green kaftan', 'price_asc'],
  ['harmattan', 'price_asc'],
  ['savanna lace', 'newest'],
  ['baobab cotton', 'price_desc'],
];

const labelOf = (attribute) =>
  attribute.type === 'dimension'
    ? dim(attribute.dimension, attribute.value)
    : `${attribute.type}:${attribute.value}`;
const matches = (expected, label) =>
  (Array.isArray(expected) ? expected : [expected]).some((candidate) =>
    candidate === 'price:*' ? label.startsWith('price:') : candidate === label,
  );
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
};

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_search_quality_' + randomUUID().replaceAll('-', '');
  assert(/^aru_search_quality_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: target.toString() });
  let created = false,
    connected = false,
    prisma;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const migrated = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '../node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          DATABASE_URL: target.toString(),
          THREADLY_PRISMA_SKIP_SEED: 'true',
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (migrated.status !== 0)
      console.error(
        String(migrated.stderr || migrated.stdout)
          .replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]')
          .split(/\r?\n/)
          .slice(-12)
          .join('\n'),
      );
    assert.equal(migrated.status, 0, 'Disposable migration deploy failed');
    await db.connect();
    connected = true;
    await db.query("SET statement_timeout='120s'");
    await seedCatalogue(db, CATALOGUE);
    await db.query('ANALYZE');
    console.log(`SETUP real migrations and ${CATALOGUE} fixture products`);

    let statements = 0;
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: withUtcDatabaseUrl(target.toString()),
      }),
      log: [{ level: 'query', emit: 'event' }],
    });
    prisma.$on('query', () => statements++);
    const built = await new SearchLexiconRebuilder(prisma).rebuildLexicon({
      deadline: new Date(Date.now() + 60_000),
      maxRows: 10_000,
    });
    assert.equal(built.status, 'replaced');
    const reader = new SearchLexiconReader(prisma);
    assert(await reader.index(), 'The stored lexicon is readable');
    const search = new SearchProductIntelligence(prisma, reader);
    const now = new Date();
    const eligible = new Set(
      (
        await prisma.$queryRaw(
          Prisma.sql`SELECT p."_id"::text AS id FROM "Product" p WHERE ${marketCatalogProductFiltersSql([{}], now)}`,
        )
      ).map((row) => row.id),
    );
    assert(eligible.size > CATALOGUE * 0.5, 'Most of the catalogue is public');

    // SEARCH_EXPLAIN="q1|q2" prints the plan hot spots of those relevance pages.
    for (const query of (process.env.SEARCH_EXPLAIN || '')
      .split('|')
      .filter(Boolean)) {
      const parsed = await search.understand(
        query,
        parseSearchProductRequest({}),
      );
      const sql = searchProductSql({
        now: new Date(),
        layers: [{}, parsed.filters],
        exactNameLayers: [{}],
        residual: parsed.residual,
        residualGroups: parsed.residualGroups,
        fullQuery: parsed.normalizedQuery,
        boosts: parsed.boosts,
        showLessBrandIds: [],
        sort: 'relevance',
        epochId: null,
        limit: 24,
        offset: 0,
        facets: false,
      });
      const plan = await db.query(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql.text,
        sql.values.map((value) =>
          value instanceof Date ? value.toISOString() : value,
        ),
      );
      const top = plan.rows[0]['QUERY PLAN'][0];
      const nodes = [];
      const walk = (node, depth) => {
        nodes.push([
          node['Actual Total Time'] * (node['Actual Loops'] || 1),
          depth,
          node['Node Type'] +
            (node['Relation Name'] ? ' ' + node['Relation Name'] : '') +
            (node['Index Name'] ? ' ' + node['Index Name'] : '') +
            ' loops=' +
            node['Actual Loops'] +
            ' rows=' +
            node['Actual Rows'],
        ]);
        for (const child of node.Plans || []) walk(child, depth + 1);
      };
      walk(top.Plan, 0);
      nodes.sort((a, b) => b[0] - a[0]);
      console.log(
        `EXPLAIN "${query}": planning ${top['Planning Time'].toFixed(1)} ms, execution ${top['Execution Time'].toFixed(1)} ms`,
      );
      for (const variant of [
        [
          'filters only',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${marketCatalogProductFiltersSql([{}, parsed.filters], new Date())}`,
        ],
        [
          'eligibility only',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${marketCatalogProductFiltersSql([{}], new Date())}`,
        ],
        [
          'eligibleProductSql',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${require('../src/market/eligibility/market-eligibility').eligibleProductSql(new Date())}`,
        ],
        [
          'cover rule',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${require('../src/market/catalog/market-filter.sql').marketRenderableCoverSql()}`,
        ],
        [
          'stock selection',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${require('../src/market/catalog/market-stock-selection.sql').marketStockSelectionSql([{}], 'p')}`,
        ],
        [
          'scope',
          Prisma.sql`SELECT count(*) FROM "Product" p WHERE ${require('../src/market/catalog/market-filter.sql').marketCatalogLayerFiltersSql([{}], new Date())}`,
        ],
      ]) {
        const vplan = await db.query(
          'EXPLAIN (ANALYZE, FORMAT JSON) ' + variant[1].text,
          variant[1].values.map((value) =>
            value instanceof Date ? value.toISOString() : value,
          ),
        );
        const vtop = vplan.rows[0]['QUERY PLAN'][0];
        console.log(
          `  [${variant[0]}] planning ${vtop['Planning Time'].toFixed(1)} ms, execution ${vtop['Execution Time'].toFixed(1)} ms`,
        );
      }
      for (const [ms, depth, label] of nodes.slice(0, 12))
        console.log(`  ${ms.toFixed(1)}ms d${depth} ${label}`);
    }
    const latencies = [];
    const timings = [];
    const failures = [];
    let queries = 0,
      filterChecks = 0;
    const run = async (query, sort = 'relevance', limit = 24) => {
      queries++;
      const request = parseSearchProductRequest({ sort });
      const parsed = await search.understand(query, request);
      const before = statements;
      const started = performance.now();
      const page = await search.page(parsed, request, {
        limit,
        offset: 0,
        facets: false,
      });
      latencies.push(performance.now() - started);
      timings.push([performance.now() - started, `${query} (${sort})`]);
      if (sort === 'relevance' && statements - before !== 1)
        failures.push(`${query}: ${statements - before} statements per page`);
      // A product whose whole name is the query is the one documented
      // exception to parsed filters (never to explicit filters or eligibility).
      const ids = page.items.map((item) => item.id);
      const checked = page.items
        .filter((item) => !item.exact)
        .map((item) => item.id);
      if (page.items.some((item) => item.exact && !eligible.has(item.id)))
        failures.push(`${query}: an ineligible exact-name product`);
      // Every other returned item satisfies every applied filter.
      if (checked.length) {
        const [{ count }] = await prisma.$queryRaw(
          Prisma.sql`SELECT count(*)::int AS count FROM "Product" p
            WHERE p."_id" = ANY(${checked}::uuid[]) AND ${marketCatalogProductFiltersSql([parsed.filters], now)}`,
        );
        filterChecks++;
        if (count !== checked.length)
          failures.push(
            `${query}: ${checked.length - count} items outside filters`,
          );
        if (checked.some((id) => !eligible.has(id)))
          failures.push(`${query}: an ineligible product was returned`);
      }
      // Relevance precedence: no worse tier above a better one, and a
      // non-relevance sort never shows ILIKE-only matches.
      const tiers = page.items
        .filter((item) => !item.exact)
        .map((item) => Number(item.tier));
      if (
        sort === 'relevance' &&
        tiers.some((tier, at) => at > 0 && tier < tiers[at - 1])
      )
        failures.push(`${query}: a worse tier ranked above a better one`);
      if (sort !== 'relevance' && tiers.includes(2))
        failures.push(`${query} (${sort}): ILIKE-only item in a sorted page`);
      return { parsed, page, ids };
    };

    // 1. Exact names: the named product ranks first.
    const byName = new Map();
    for (const row of await prisma.$queryRaw(
      Prisma.sql`SELECT p."_id"::text AS id, p.name FROM "Product" p
        WHERE p."_id" = ANY(${[...eligible]}::uuid[]) ORDER BY p."_id"`,
    ))
      byName.set(row.name, byName.has(row.name) ? null : row.id);
    const exact = NAMED.map(([named]) => named).filter((named) =>
      byName.get(named),
    );
    for (const [candidate, id] of byName)
      if (id && exact.length < 40 && !exact.includes(candidate))
        exact.push(candidate);
    let exactHits = 0,
      zeroCovered = 0,
      covered = 0;
    for (const named of exact) {
      const { ids } = await run(named);
      covered++;
      if (!ids.length) zeroCovered++;
      if (ids[0] === byName.get(named)) exactHits++;
      else
        failures.push(
          `exact "${named}" ranked ${ids.indexOf(byName.get(named)) + 1 || 'absent'}`,
        );
    }

    // 2. Attribute parsing: precision and recall over labelled queries.
    let parsedCorrect = 0,
      parsedTotal = 0,
      expectedFound = 0,
      expectedTotal = 0;
    for (const [query, expected] of PARSE) {
      const { parsed, ids } = await run(query);
      covered++;
      if (!ids.length) zeroCovered++;
      const labels = parsed.attributes
        .filter((item) => item.applied === 'filter' || item.applied === 'boost')
        .map(labelOf);
      parsedTotal += labels.length;
      parsedCorrect += labels.filter((label) =>
        expected.some((item) => matches(item, label)),
      ).length;
      expectedTotal += expected.length;
      const found = expected.filter((item) =>
        labels.some((label) => matches(item, label)),
      );
      expectedFound += found.length;
      if (found.length !== expected.length || labels.length > expected.length)
        failures.push(`parse "${query}": got [${labels.join(', ')}]`);
    }

    // 3. Typos: a one-edit query still finds what the clean query finds.
    let typoHits = 0;
    for (const [typo, clean] of TYPOS) {
      const intended = new Set((await run(clean, 'relevance', 50)).ids);
      const { ids } = await run(typo);
      covered++;
      if (!ids.length) zeroCovered++;
      if (ids.slice(0, 5).some((id) => intended.has(id))) typoHits++;
      else failures.push(`typo "${typo}" missed "${clean}"`);
    }

    // 4. Queries the catalogue cannot satisfy never error and never invent.
    for (const [query, mustBeEmpty] of UNSATISFIABLE) {
      const { ids } = await run(query);
      if (mustBeEmpty && ids.length)
        failures.push(`gibberish "${query}" returned ${ids.length} items`);
    }

    // 5. Sorted pages keep the requested order.
    for (const [query, sort] of SORTED) {
      const { page } = await run(query, sort);
      const amounts = page.items.map((item) => Number(item.effectivePrice));
      if (
        sort === 'price_asc' &&
        amounts.some((value, at) => at > 0 && value < amounts[at - 1])
      )
        failures.push(`${query}: price_asc out of order`);
      if (
        sort === 'price_desc' &&
        amounts.some((value, at) => at > 0 && value > amounts[at - 1])
      )
        failures.push(`${query}: price_desc out of order`);
    }

    const metrics = {
      queries,
      exactP1: exactHits / exact.length,
      parsePrecision: parsedCorrect / parsedTotal,
      parseRecall: expectedFound / expectedTotal,
      typoRecall5: typoHits / TYPOS.length,
      zeroResultRate: zeroCovered / covered,
      p95Ms: Math.round(p95(latencies)),
      filterChecks,
    };
    console.log('METRICS ' + JSON.stringify(metrics));
    timings.sort((a, b) => b[0] - a[0]);
    console.log(
      'SLOWEST ' +
        timings
          .slice(0, 8)
          .map(([ms, label]) => `${Math.round(ms)}ms ${label}`)
          .join(' | '),
    );
    for (const failure of failures.slice(0, 60))
      console.log('  MISS ' + failure);
    const hard = failures.filter(
      (failure) => !/^(exact|parse|typo) /.test(failure),
    );
    assert(queries >= 150, 'At least 150 labelled queries');
    assert.deepEqual(
      hard,
      [],
      'Filters, eligibility, tiers, sorts, statements',
    );
    assert(metrics.exactP1 >= 0.95, 'Exact-name P@1 >= 0.95');
    assert(metrics.parsePrecision >= 0.9, 'Parse precision >= 0.90');
    assert(metrics.parseRecall >= 0.85, 'Parse recall >= 0.85');
    assert(metrics.typoRecall5 >= 0.8, 'Typo recall@5 >= 0.80');
    assert(metrics.zeroResultRate <= 0.05, 'Zero-result rate <= 5 %');
    if (LATENCY_P95_MS !== null)
      assert(
        metrics.p95Ms <= LATENCY_P95_MS,
        `Search p95 <= ${LATENCY_P95_MS} ms`,
      );
    else
      console.log(
        `LATENCY p95 ${metrics.p95Ms} ms (300 ms budget tracked in WP17; set SEARCH_P95_BUDGET_MS to enforce)`,
      );
    console.log(
      `PASS search quality: ${queries} labelled queries on ${CATALOGUE} products`,
    );
  } finally {
    try {
      if (prisma) await prisma.$disconnect();
      if (connected) await db.end();
    } finally {
      try {
        if (created) {
          assert(/^aru_search_quality_[a-f0-9]{32}$/.test(name));
          await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
          const left = await admin.query(
            'SELECT 1 FROM pg_database WHERE datname=$1',
            [name],
          );
          assert.equal(left.rowCount, 0, 'Disposable database removed');
        }
      } finally {
        await admin.end();
      }
    }
  }
}

main().catch((error) => {
  console.error(
    error.name +
      ': ' +
      String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'),
  );
  process.exitCode = 1;
});
