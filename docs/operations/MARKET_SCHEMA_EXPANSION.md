# Market additive schema expansion

The eleven migrations add infrastructure. They do not activate a new Market
pipeline, personalization, regional ranking, vocabulary, chip sets or admin
publication. Complete the integrated release checks before application. Leave
existing V1 configuration operational until its explicit, separately tested
conversion. No production capacity is inferred from a small local fixture.

## Before application

1. Confirm the intended release SHA and database, backup/restore evidence and
   maintenance/recovery owner. Apply only through the normal migration runner.
2. Run `node scripts/market-schema-preflight.cjs` against the intended environment.
   This is read-only. Save its index definitions/validity, PostgreSQL version,
   invalid-price count and table reloptions in a private release artifact.
3. An invalid historical price stops the release; identify and correct the
   underlying record explicitly. Never replace an invalid amount with zero,
   delete an order, or rewrite an existing quote/payment to pass validation.
4. Verify full migration replay on empty and populated disposable PostgreSQL:
   `npm run test:market-schema-postgres`. The test accepts loopback hosts only,
   creates new databases, and never puts fixtures into an application database.
5. Review the expected index definitions. Existing FTS/trigram and variant-stock
   indexes are reused. A concurrent index must be both `indisvalid` and
   `indisready`; its name alone proves neither completion nor equivalence.

## Apply and backfill

Run the normal `prisma migrate deploy` release step. Most additive groups have
five-second lock and thirty-second statement deadlines. The concurrent-index
group has no transaction wrapper and allows ten minutes per statement. A timeout
is a failed release requiring investigation, not permission to bypass a check.

Preview the product backfill without writing:

```sh
npm run market:backfill-products -- --batch-size=500 --max-batches=20
```

After the environment and backfill have been approved, use the actual database
name in the explicit write command:

```sh
npm run market:backfill-products -- --apply --confirm-database=DATABASE_NAME --batch-size=500 --max-batches=20
```

Each batch uses an ordered UUID keyset, row locks, a two-second lock deadline
and a fifteen-second statement deadline. Resume **an apply pass** using its
reported `after` value with `--after=UUID`. Do not reuse a dry-run cursor to skip
records in the first apply pass. `exhausted:false` means unfinished. Rerunning
from the start is safe; repaired rows no longer match. Earlier committed batches
remain repaired after a later timeout or invalid record; report that partial
state and resume deliberately. Bound invocation frequency as well as batch size.

The database trigger labels inferred historic first-publication dates. A future
scheduled date remains provisional until effective publication, then survives
edits, unpublication and relisting. A row-lock wait across that date must not
erase it. Duplicating a product starts a new lifecycle. Drafts stay unpublished.

Stored effective prices are a cache. Captured-time SQL and TypeScript share the
same decimal rules: a sale is positive and below base, dates must be finite and
ordered, and the ending millisecond is included. Readers must respect the cache
boundary; exact ordering cannot depend on a periodic sweep. Existing quotes and
payments retain their recorded amounts. Product transaction-ID indexing includes
former result members so a price change outside the current filter is detected.

After a clean backfill, validate the explicitly added constraints:

```sh
node scripts/validate-market-schema.cjs --confirm-database=DATABASE_NAME
node scripts/market-schema-preflight.cjs
```

Validation uses short independent transactions and does not modify records.
Missing/invalid constraints, unexpected prices or invalid indexes remain release
blockers. Validate the completed backfill and exact source/constraint parity;
the preflight is not an automatic release approval.

## Contracts subsequent packages must preserve

- An immutable feature snapshot, its READY manifest and current pointer publish
  in one repeatable-read transaction. BUILDING/partial/stale writers are rejected.
  A generation is not interchangeable with another in the same six-hour bucket.
  Worker admission, source completeness, fresh-feature timing and bounded retained
  storage must be verified before activation. Deleting a product may erase its
  snapshot entries without rewriting the surviving immutable scores.
- An affinity cache requires expiry and source windows. Unknown metrics are NULL;
  UNAVAILABLE is not a measured zero or a nonempty interest vector. These columns
  authorize neither longer source retention nor background profiling.
- Section drafts contain both ranking specification and full presentation.
  Drafts do not alter served labels/order/audience/schedule. Publish/restore must
  create and select a new immutable version atomically with authorization and
  audit. After conversion, legacy direct projection writers fail closed. Restore
  creates history; it never edits an old version. Author erasure deidentifies
  attribution while retaining the definition.
- Placement/position defaults preserve existing featured behavior and active
  entity uniqueness. Multiple simultaneous placements for one entity remain a
  separate product/constraint decision, not an implicit migration side effect.
- Complement proposals default PENDING; approval and eligibility remain distinct.
  Graph mutations for synonyms require SERIALIZABLE transactions with bounded
  retry on PostgreSQL `40001`. Normalization is NFKC, trim and lower-case per kind;
  cycles and paths reaching 128 edges are rejected. No vocabulary is auto-seeded.
- Chip sets contain at most eight chips. ACTIVE schedule windows use `[start,end)`.
  Adjacent windows and different surfaces are allowed; same-surface overlap is
  rejected by a PostgreSQL exclusion constraint, including concurrent writers.
  Only the two existing surfaces are represented; adding a surface must update
  this exclusion mapping. Typed filter validation and admin authorization remain
  required before serving these records.
- Taxonomy aliases do not approve categories or garment types. Attribution is
  optional for old clients and server-validated before use. Preference defaults
  are not analytics consent or permission to activate regional ranking.

## Failure and forward recovery

Schema changes are additive. Roll back application readers/writers while leaving
new columns and tables unused; do not drop data to reverse a release. Database
write invariants remain deliberate: an old writer cannot mutate an already
versioned section. Complete writer integration before converting live sections.

If a concurrent build fails, inspect `_prisma_migrations`, the nine exact
`Product_market_*` index names and their definitions/validity. A failed group may
have created a valid prefix and an invalid interrupted index. Under a reviewed
recovery operation, drop only this group's verified indexes using individual
`DROP INDEX CONCURRENTLY` statements outside a transaction, mark that failed
migration rolled back with `prisma migrate resolve`, then rerun deploy and verify
all nine definitions/flags. Never use `IF NOT EXISTS` to bless an invalid or
different index, and never drop an unrelated existing search index.

The regression saves a read-only schema comparison in
`.tmp/market-schema-drift.sql` and fails for changes to this package's managed
models/fields. The older schema intentionally contains SQL-managed constructs,
including generated typed TagBinding targets and their erasure foreign keys.
A Prisma comparison may suggest removing these; **never execute that generated
comparison**. Preserve the reviewed historical SQL and inspect an unrelated
difference separately from this expansion.

Restore prior per-table autovacuum reloptions from the captured preflight record
through a forward operational change if required. No global PostgreSQL setting,
immutable feature history or unrelated table is part of that change.

## Unreleased catalogue prerequisite refinements

The held catalogue package refines the existing eleven migration groups; none has been applied to a live environment. Group2 adds Product_market_price_cache_ready_check (NOT VALID), and the bounded backfill repairs missing cache price, time or transaction metadata. Validate this constraint after backfill before admitting price reads. Group10 now contains nine concurrent indexes: newest UUID ties use DESC; price DESC/UUID ASC gets its own index; cache computed time gets an index for backwards-clock handling. The existing ascending-price, boundary, transaction-change and tag indexes remain. Group3 adds nullable savesCount to live and frozen features, COMPLETE evidence validation, saved/units frozen-order indexes, and the full descending trend order. Unknown saved counts remain NULL. The owner-approved Most saved contract replaces the unmaintained product-like counter; it does not add user-event retention.

Before enabling catalogue pagination, configure an independent high-entropy MARKET_CURSOR_SECRET (at least32 bytes), optional MARKET_CURSOR_SECRET_PREVIOUS during rotation, and a UUID MARKET_CATALOG_NAMESPACE held outside the restored database. Rotate that namespace after any database restore, including restoring into the same host. Keeping the old namespace after restore would let old ordering state be reused. Keep both cursor keys private; never reuse sign-in or refresh secrets. No current APP_SECRET configuration exists.

The prepared catalogue read runner admits at most four concurrent transactions
per API process and rejects excess work before connection acquisition. Reads use
READ ONLY / REPEATABLE READ, a 1500ms PostgreSQL statement deadline, 250ms lock
deadline, 250ms transaction-acquisition budget and 2000ms transaction ceiling.
This is a process-local bound; fleet-wide ingress admission remains a separate
release requirement. A retryable read-limit response contains no database text.
The installed PostgreSQL adapter exposes SQLSTATE through structured driver
error metadata; do not classify errors by inspecting their private messages.

Frozen-score readers require READY, time/version-compatible manifests and
COMPLETE source-window evidence, then recheck current product eligibility.
Unknown history is not zero. Product checks use a bounded primary-key lookup;
the regression verifies that score pagination does not repeatedly traverse the
newest-product index. This ordering helper alone does not establish source
freshness, sample floors or permission to advertise a sort. Catalogue/facet
responses, surface integration and full acceptance remain unfinished. Keep the
surface selector empty until the complete integration is verified and approved.
