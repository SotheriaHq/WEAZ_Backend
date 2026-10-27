# Tag projection recovery

Content tags are authoritative; bindings and usage counters are projections.
The projector locks sources in table/UUID order, reads their saved state in a
separate statement, then locks tags and resolves current aliases. Delayed old/new
arrays cannot restore an older edit. Immediate request projection remains; a
durable retry covers a process stopping after the source commit.

## Handoff and bounded recovery

Migration `20261027160000_tag_projection_outbox` adds two internal instruction
tables. Source triggers coalesce by `(entityType, entityId)`, replacing a UUID
generation whenever tags or publication/visibility eligibility changes. Source
and instruction commit together or both roll back. Instructions intentionally
have no source/tag foreign keys: deletion repair must survive deleted targets.
Tag-binding statement triggers enqueue distinct affected tag counters, including
actual typed-FK cascade deletion.

Every ten seconds the service claims at most 25 source and 100 counter jobs with
`FOR UPDATE SKIP LOCKED`. Claims commit before source/tag locks. Each attempt has
a unique owner and 60-second lease. Worker acknowledgements/failures require the
same generation and current unexpired owner. Immediate projection acknowledges
only its captured generation. Background source locking uses `NOWAIT`; busy
sources retry after five seconds without spending the failure budget.
Projection transactions time out after 15 seconds.

Failed batches split into individual jobs so malformed sources cannot block
healthy neighbours. Other failures back off from 30 seconds to at most one hour;
the eighth failure is quarantined. A lost final-attempt lease becomes `FAILED`
with `DLQ_EXHAUSTED` in `lastError`. Source edits start a new generation and reset
retries. Logs contain codes/counts, not content, connection strings or secrets.

Future active products retain an instruction due at `publishAt`. The database
clock controls eligibility, so no new edit or full scan is required when that
time arrives. Counter calculation and captured-generation acknowledgement use
the same SQL snapshot. A concurrent cascade replacing that generation leaves
its new repair instruction intact.

Admin alias mutations serialize before ordered tag locks. Targets resolve to
their canonical tag; inverse merges that would form cycles fail. Binding moves
use batches of at most 500 in one transaction (30-second timeout). The guard
applies to the application merge service; direct privileged SQL is an operator
responsibility.

## Rollout and operator checks

1. Apply the additive migration before the new binary. Generate Prisma during
   the normal build.
2. Run the existing authorized tag reindex once to cover source commits before
   this migration. It uses 500-row cursor pages, never globally deletes the
   index, and repairs all tag counters, including tags with no surviving
   bindings. Normal recovery does not scan all sources.
3. Monitor queue status, oldest due age, expired leases and exhausted failures.
   Queue size reflects unique dirty sources/tags, not every intermediate edit.
4. Fix the underlying source/alias before retrying an exhausted job. Prefer a
   source correction through the application. An operational retry must target
   a specific exhausted row with a generation-conditional transactional update:
   set `PENDING`, attempts zero and `availableAt` to the database UTC time; clear
   all three lease fields. Never reset whole queues or clear a current owner.
5. Binary rollback can retain additive tables/triggers; they keep instructions
   for later recovery. Do not drop pending work.

## Evidence and limits

`node scripts/verify-tag-sync-batching.cjs` creates a disposable loopback database,
applies the full migration chain, tests real services and deletes that database.
The historical evidence filename is
`docs/performance-reviews/tag-sync-postgres-2026-10-23.json`; `checkedAt` identifies
the current run. Its 23 cases include real source-lock waits, 32 competing
claimants, stale leases/generations, scheduled publication without another edit,
all five source types, FK deletion, poison isolation, final-attempt recovery,
inverse merges and atomic outbox failure. The 2004-entity rebuild uses 74 reads
and nine grouped counter updates (including the final counter-repair page).
Local verification does not certify SIT rollout, application-wide capacity,
client layout or device delivery.

PostgreSQL references: [locking clauses](https://www.postgresql.org/docs/15/sql-select.html#SQL-FOR-UPDATE-SHARE),
[data-modifying CTE snapshots](https://www.postgresql.org/docs/15/queries-with.html#QUERIES-WITH-MODIFYING),
and [triggers and FK actions](https://www.postgresql.org/docs/15/trigger-definition.html).
