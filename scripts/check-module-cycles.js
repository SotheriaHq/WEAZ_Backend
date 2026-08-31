#!/usr/bin/env node
/**
 * Fails the build when a NestJS module cycle is left WITHOUT `forwardRef`.
 *
 * ## The failure this exists to prevent
 *
 * Between 2026-08-15 and 2026-08-24 the SIT worker restarted 74,771 times with:
 *
 *   Error: Cannot access 'StoreModule' before initialization
 *       at .../dist/categories/categories.module.js:19
 *       at .../dist/collections/collections.module.js:49
 *
 * The cycle was StoreModule -> CategoriesModule -> CollectionsModule ->
 * StoreModule. `collections.module.ts` named `StoreModule` DIRECTLY in its
 * `imports` array, which is evaluated the moment the module file is required.
 * In a cycle one of those files is always still mid-evaluation, so its `class`
 * binding is in the temporal dead zone and reading it throws.
 *
 * Nothing caught it because it is not a type error and not a lint error — the
 * code is perfectly valid TypeScript. It is an *evaluation-order* bug, and
 * whether it throws depends on which entry point loads the graph first. The API
 * reached CollectionsModule first and survived; `worker.ts` reached it the other
 * way round and died on every boot for nine days.
 *
 * `forwardRef(() => StoreModule)` fixes it by deferring the read until Nest
 * resolves the graph, long after every module file has finished evaluating.
 *
 * ## What this checks
 *
 * Every `@Module({ imports: [...] })` in `src/**\/*.module.ts` is parsed for the
 * modules it names. Cycles in that graph are located, and EVERY bare (not
 * `forwardRef`-wrapped) edge inside a cycle is reported.
 *
 * "One forwardRef somewhere in the ring is enough" is NOT the rule, and
 * believing it is what let this bug ship: on 2026-08-15 the ring
 * StoreModule -> CategoriesModule -> CollectionsModule -> StoreModule already
 * had a `forwardRef` on the Categories -> Collections edge, and the worker still
 * died — because the edge that throws is whichever bare one happens to close the
 * require chain, and which one that is depends on the entry point. `main.ts` and
 * `worker.ts` root the graph differently, so an edge that is safe in the API can
 * be fatal in the worker. Nothing static can tell them apart, so every bare edge
 * in a ring is treated as a latent failure.
 *
 * Deliberately a text scan and not a TypeScript program: it has to run in a
 * second, with no dependencies, so it can sit in front of every build.
 */
const fs = require('node:fs');
const path = require('node:path');

// Overridable so the guard itself can be tested against fixture trees; defaults
// to this repo's src/ for every real invocation.
const SRC = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'src');

/** All `*.module.ts` files under src/. */
function moduleFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) moduleFiles(full, out);
    else if (entry.name.endsWith('.module.ts')) out.push(full);
  }
  return out;
}

/**
 * The `imports:` array of the file's `@Module({...})` decorator.
 *
 * Found by brace-matching from `@Module(` rather than by regex, because the
 * decorator spans many lines and contains nested arrays and objects.
 */
function moduleImportsBlock(source) {
  const start = source.indexOf('@Module(');
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start + '@Module'.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const decorator = source.slice(start, end);
  const importsAt = decorator.indexOf('imports:');
  if (importsAt === -1) return null;

  const open = decorator.indexOf('[', importsAt);
  if (open === -1) return null;

  let bracket = 0;
  for (let i = open; i < decorator.length; i += 1) {
    const ch = decorator[i];
    if (ch === '[') bracket += 1;
    else if (ch === ']') {
      bracket -= 1;
      if (bracket === 0) return decorator.slice(open + 1, i);
    }
  }
  return null;
}

/** Strip comments so a commented-out import is not counted as an edge. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) => line.replace(/\/\/.*$/, ' '));
}

const files = moduleFiles(SRC);

/** class name -> { file, edges: Map<importedClass, deferred:boolean> } */
const graph = new Map();

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const source = stripComments(raw);

  const declared = /export\s+class\s+(\w+)/.exec(source);
  if (!declared) continue;
  const self = declared[1];

  const block = moduleImportsBlock(source);
  const edges = new Map();

  if (block) {
    // `forwardRef(() => X)` — the deferred form.
    for (const m of block.matchAll(/forwardRef\s*\(\s*\(\s*\)\s*=>\s*(\w+)/g)) {
      edges.set(m[1], true);
    }
    // Bare `X` or `X.forRoot(...)`/`X.register(...)` — evaluated immediately.
    for (const m of block.matchAll(/(^|[,[\s])([A-Z]\w*Module)\b/g)) {
      if (!edges.has(m[2])) edges.set(m[2], false);
    }
  }

  graph.set(self, { file: path.relative(path.join(SRC, '..'), file), edges });
}

/**
 * Every elementary cycle, via DFS over the current path.
 *
 * Deduplicated by rotating each cycle to start at its alphabetically smallest
 * member, so A->B->A and B->A->B are reported once.
 */
const cycles = new Map();

function walk(node, pathSoFar, seen) {
  const entry = graph.get(node);
  if (!entry) return;

  for (const next of entry.edges.keys()) {
    if (!graph.has(next)) continue;

    const at = pathSoFar.indexOf(next);
    if (at !== -1) {
      const ring = pathSoFar.slice(at);
      const lowest = ring.indexOf([...ring].sort()[0]);
      const rotated = [...ring.slice(lowest), ...ring.slice(0, lowest)];
      cycles.set(rotated.join('->'), rotated);
      continue;
    }
    if (seen.has(next)) continue;

    seen.add(next);
    walk(next, [...pathSoFar, next], seen);
  }
}

for (const node of graph.keys()) walk(node, [node], new Set([node]));

/** Every bare edge that sits inside a ring. Keyed so one edge reports once. */
const offenders = new Map();
for (const ring of cycles.values()) {
  for (let i = 0; i < ring.length; i += 1) {
    const from = ring[i];
    const to = ring[(i + 1) % ring.length];
    if (graph.get(from).edges.get(to) === true) continue;

    const key = `${from}->${to}`;
    if (!offenders.has(key)) offenders.set(key, { from, to, rings: [] });
    offenders.get(key).rings.push(ring);
  }
}

const total = cycles.size;

if (offenders.size === 0) {
  console.log(
    `[module-cycles] OK — ${graph.size} modules, ${total} cycle(s), every edge in a cycle deferred with forwardRef.`,
  );
  process.exit(0);
}

console.error(
  `\n[module-cycles] ${offenders.size} module import(s) inside a cycle are NOT wrapped in forwardRef.\n`,
);
console.error(
  'Each can throw "Cannot access \'X\' before initialization" at boot, depending on\n' +
    'which entry point (main.ts or worker.ts) loads the graph first — the failure that\n' +
    'restarted the SIT worker 74,771 times. Wrap the import in forwardRef(() => X).\n',
);

for (const { from, to, rings } of offenders.values()) {
  console.error(`  ${graph.get(from).file}`);
  console.error(`    imports ${to} directly; wrap it: forwardRef(() => ${to})`);
  console.error(`    cycle: ${[...rings[0], rings[0][0]].join(' -> ')}`);
  console.error('');
}

process.exit(1);
