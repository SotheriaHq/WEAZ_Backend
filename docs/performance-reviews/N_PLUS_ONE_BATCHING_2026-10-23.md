> Latest25October: item2 locally complete;178frozen reviews/105fixed/zero unreviewed,98unit tests/types and actual PG35+25+18cases/cleanup PASS. Broader release gates remain open. Earlier counts below describe historical stages.

# N+1 audit progress — 23 October 2026

Item1 is on hold by the owner's24 October instruction until the other checklist items are complete. Its actual database/backend cutover and APK release have already passed; the remaining web release stays held. This document records the resumed item2 work. The whole N+1 audit is still open.

## 24 October — category moderation

Category approval/rejection read draft pages of25 using a LATERAL JOIN for media
existence, avoiding full owner/file payloads and an unbounded result set. Each
draft keeps its independent write/cleanup transaction. Conditional writes skip
drafts that were deleted, published or assigned to another suggestion after the
page read. Notification preferences, email suppression and deduplication are
loaded once per page through createEvents; payloads remain specific to each draft.
A failed recipient no longer turns a successful publication into a publish failure
or aborts later pages. Rejection counts retain the existing fulfilled-notification
semantics, including preference-based no-op results.

The focused moderation/collection suites pass32 tests. Actual PostgreSQL passes
11 scenarios with cleanup:26 drafts require3 projection SELECTs; approval and
rejection each use9 total SELECTs including email suppression. Both CI workflows
include the new test and existing expanded PostgreSQL fixture; neither has been
dispatched for this uncommitted work. Frozen candidates51–54 are closed only for
their recipient-policy fanout. Category approval's existing direct publication
without the canonical content-readiness/review checks remains an explicit
canonical-flow audit finding, not certified by these performance checks.

## 24 October — cron and paid-order follow-up

Acceptance-risk and completed-order jobs reuse the existing brand-owner batch
reader once per bounded scan. Two extension-reminder callers outside the frozen
inventory now use that same reader. Owner identity stays operation-local; it is
read again on the next invocation. No payout, complaint-lock or ledger command
was removed. Thirteen cron tests pass, and26 brand owners take one actual SELECT.

Paid standard/custom-order notifications share25-event preference/actor batches.
Each keeps its own order target, buyer/brand copy, amount metadata and destination.
A recipient or metadata-read failure cannot fail an already committed payment.
Standard conversation creation remains a separate open command review. Placement
and payment suites pass36 tests; no financial/provider behavior is certified by
the notification-only checks.

Bag reminders retain their two-hour dedupe,500-cart-item scan, oldest-item title
and per-shopper quantities. Out-of-stock scans use two explicit Product/Brand
JOIN projections; notifications share policy reads and only fulfilled reminders
advance timestamps in one conditional update. Current product guards exclude
restocked, archived, deleted or disabled products from that update. Eighteen
scheduler tests pass; the broader Store suite passed before the JOIN-only
projection follow-up. Actual PostgreSQL passes14 scenarios with cleanup:
26 stock reminders use8 SELECTs and1 timestamp write;26 bag shoppers use8 SELECTs.

The initial ORM measurement was10 SELECTs for stock reminders, including two
product/brand projection pairs. Explicit JOINs reduced it to8; the fixture
retains the read-table trace. Both quality workflows include placement coverage
and the expanded existing PostgreSQL fixture, pending the item2 release.

## 24 October — receipt, tag rebuild and file claims

Each billing result still commits its inbox and email receipts in the financial
transaction. One Brand/User JOIN supplies the current recipient. Duplicate-safe
scalar inserts replace no-change ORM upserts, removing four hidden receipt reads.
Actual PostgreSQL uses one SELECT per receipt and verifies idempotent replay and
whole-transaction rollback. Eighteen subscription tests pass. These are required
transactional commands, not display-row fanout; recipient data is not prefetched
across separate payment transactions. Access rules and subscription tiers did not
change.

Tag reindexing reads each of its four existing source types in500-row keyset pages
and synchronizes each page through the shared tag batch implementation. Moderation
lookups are bounded, and both banned and rejected tags are omitted. The brand-user
scope retains its owner identity and10-tag limit; other scopes retain30. Ten runtime
tests and six actual PostgreSQL scenarios pass. The501-entities-per-type fixture
retains2,004 bindings using37 standalone SELECTs and eight grouped count updates.
Those updates are reported separately rather than hidden from the measurement.
The existing rebuild reset versus live-edit race remains open for the race audit.

Image jobs apply the normal READY skip inside their conditional lease claim,
removing the preclaim SELECT. Only the winner reads its authoritative current file.
Actual competing claims use one postlease SELECT; READY/missing skips use none.
Eleven image-worker tests pass, including forced immutable re-encoding, lost lease,
storage failure and retry behavior. The shared PostgreSQL fixture now passes16
scenarios with cleanup. These checks cover query and claim behavior; image quality
and final storage activation retain their own verification gates.

Both backend workflows include the tag rebuild test/real fixture and the image
processor regression suite. Workflow YAML parses locally; no new workflow or
deployment was dispatched for this work.

## 24 October — order conversation and durable queue scope

Standard-order placement uses the main messaging pair advisory-lock key and a
joined thread-selection row lock. A separate thread/placement JOIN after the lock
wait supplies current metadata; earlier metadata is not reused after waiting.
Link/participant inserts are duplicate-safe, and the existing monotonic message
clock prevents preview timestamps moving backwards. Payment callbacks keep one
independent transaction per order, with at most four conversation transactions
started concurrently. Existing unpaired conversations are adopted in place.

Thirty-seven payment/placement tests pass. Actual PostgreSQL verifies competing
callbacks, one conversation, one placement per order, two recipient outbox events,
two data reads on replay, an actual row-lock wait, monotonic preview/message time,
whole-command rollback and missing-shopper no-op. The separate custom-order
bootstrap remains part of the race audit.

Custom-order notification dispatch is a durable handoff command rather than
recipient-policy hydration. An UPDATE RETURNING supplies its own attempt number,
removing the error-path reread and rechecking current status, availability and
attempt limit. Two competing scans hand off25 events once using two SELECTs; the
failed event stops at its eighth attempt. Seventeen outbox/cron tests pass. The
shared actual PostgreSQL fixture now passes22 scenarios with cleanup. Queue calls
are captured for this SQL measurement; PROCESSING recovery, completion fencing
and idempotent handoff after a crash remain explicit race-audit gates.

## Implemented and measured

| Path | Change | Evidence |
| --- | --- | --- |
| Media finalization | One presign batch read reused by the canonical upload finalizer; whole-request ownership/key validation before per-file finalization. Snapshots are server-read and operation-local. Existing six-media limit enforced at both DTO and service entry. Canonical ownership, expiry, storage/signature/lease validation remains per upload. | Focused service/helper tests; generated-Prisma PostgreSQL fixture; 13 lease/UTC/competing-writer checks pass. |
| Media attachment | Collection lock before reading existing links; one membership read, one owner-brand read, one bulk insert. Preserve order, creator, review status and slot validation. | Two competing finalizers attach six files once; conflicting slots roll back every attachment. |
| Checkout reservation | Lock product IDs in canonical UUID order, then variants; hydrate stock in pages of 500 after locks. Repeated lines consume transaction-local stock cumulatively. | Real repeated-product oversell rejects and rolls back both inventory and reservation writes; empty, missing and page-boundary unit cases. |
| Checkout release | Group product/variant increments and size buckets; joined VALUES updates replace per-reservation reads and writes. Only reserved rows belonging to existing products are released. | Forty repeated-product reservations across competing attempts restore product, size and variant stock exactly once. |
| Notification fanout reads | Groups of 25 use joined user/email/scenario policy, bounded suppression/patch reads, LATERAL dedupe and shared actor hydration. Direct scalar foreign-key inserts avoid hidden ORM relationship reads. | Twenty-five recipients use 9 SELECTs including the fixture's assertion read. Category/global/scenario consent, suppression, replay and patched-only comment privacy pass. |
| Notification duplicate lookup | Retain both semantic candidates and the explicit target fast path. Preserve UTC dates when decoding PostgreSQL JSON. | An explicit matching target older than the newest 25 notifications is found and not redelivered. |
| Callers | Queue worker, design publication/reactions/media threads, post threads, comments, product patchers, wishlist lifecycle, finance-admin alerts and super-admin email-change requests use the shared batch API. | Shared implementation has local service and PostgreSQL checks. Durable worker failures still propagate; ordinary fanout remains best-effort; email-change failures still propagate. Full signed-in workflow regression remains a final gate. |
| Bulk unpublish | Skip response-only media/filter/signed-URL hydration because the bulk action returns per-item results. Preserve the shared mutation, permission guards, tag writes and collection-price recalculation. | Existing mixed-result/concurrent-lifecycle tests plus a real shared-method test verify mutation effects and absence of response hydration. |

The first fanout database measurement exposed extra SELECTs generated by nested ORM user connections. The final implementation inserts validated scalar foreign keys while retaining database constraints. No recipient policy is cached across requests/jobs. Email dispatch still rechecks current deliverability suppression at send time.

## Evidence and limits

- The expanded default Jest run passed nine suites / 121 tests, including full payment and notification service suites, the six-media guard, batch opt-out and adjacent comment/reaction behavior. Two older fixture expectations were corrected to the existing international phone format and the approved default-on notification setting; those corrections add no production behavior.
- The subsequent upload snapshot change passed all 34 upload tests under the default Jest configuration and a full backend TypeScript check. The actual publication-fence SQL and generated-Prisma claims pass 13 checks under a non-UTC PostgreSQL session, including twenty competing claims and lease expiry during a lock wait.
- scripts/verify-checkout-media-batching.cjs passed six actual PostgreSQL scenarios with successful disposable-database cleanup. Evidence: checkout-media-batching-postgres-2026-10-23.json.
- Both backend quality workflows include the new tests and PostgreSQL fixture. Their YAML parses locally; neither workflow has been dispatched for this uncommitted work.
- The frozen inventory retains all 178 original candidates: 87 are FIXED_AFTER_CAPTURE. Two cleanup entries are reviewed write-time aggregate guards; two billing entries are reviewed transactional receipts; one image entry is a reviewed leased-file command; one message entry is a reviewed locked command; one outbox entry is a reviewed durable queue command. Their authoritative reads remain inside each operation rather than using an earlier shared snapshot. There are still 1 recipient-policy entry and 44 stateful-command entries requiring semantic closure. Original READ_FANOUT_OPEN is zero; that does not close the whole inventory.
- Financial per-order post-lock guards, provider reconciliation, product mutation side effects and tag reindexing require individual review. Do not replace authoritative reads after locks with an earlier bulk snapshot. Remaining race, normalization, currency, R2, reset and notification-delivery work retain their separate release gates.

Use PostgreSQL's documented consistent lock ordering and READ COMMITTED statement visibility when evaluating any further batching: [explicit locks](https://www.postgresql.org/docs/current/explicit-locking.html), [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Customer privacy and timing follow-up

The customer list now returns only its effective purchase threshold in settings metadata. Subscription tier, upgrade eligibility and billing expiry remain behind the owner-only endpoint. Web/native commerce hooks hide previously cached owner entitlement data when owner access disappears. The customer page keeps staff records accessible and renders the Customer settings link only for owners; owners use the existing shared expiry hook to refresh criteria. Subscription expiry is evaluated after database reads complete, avoiding a stale grant when a read crosses the paid-period boundary.

Backend customer/commerce checks pass 12 tests; browser expiry and owner/staff checks pass 8 tests; native expiry/parity passes. The actual customer aggregation SQL passes again. All three applications passed full current-source TypeScript checks after this follow-up; native design audit passed with zero findings. Live API/device regression remains a final release gate.

## Files changed for this item

- src/collections/collections.service.ts
- src/collections/dto/create-collection.dto.ts
- src/collections/finalized-media-query.ts
- src/collections/finalized-media-query.spec.ts
- src/payment/payment.service.ts
- src/payment/payment.service.spec.ts
- src/payment/checkout-inventory-query.ts
- src/payment/checkout-inventory-query.spec.ts
- src/upload/upload.service.ts
- src/upload/upload.service.spec.ts
- src/notifications/notifications.service.ts
- src/notifications/notifications.service.spec.ts
- src/notifications/notification-batch-query.ts
- src/notifications/notification-batch-query.spec.ts
- src/queue/notifications.processor.ts
- src/queue/notification-durable-replay.spec.ts
- src/store/store.service.ts
- src/store/bulk-unpublish.spec.ts
- src/commentsv2/commentsv2.service.ts
- src/posts/posts.service.ts
- src/admin/email-change/admin-email-change.service.ts
- scripts/verify-checkout-media-batching.cjs
- docs/performance-reviews/checkout-media-batching-postgres-2026-10-23.json
- docs/storage/evidence/verify-r2-finalize-concurrency.json
- docs/performance-reviews/query-loop-classification-2026-10-22.json
- docs/performance-reviews/N_PLUS_ONE_BATCHING_2026-10-23.md
- docs/performance-reviews/RELEASE_GATES_2026-10-23.md
- .github/workflows/deploy.yml
- .github/workflows/phase8-quality-gate.yml

## Bulk import follow-up

The product-import job incorrectly referenced design Collection while its writes required StoreCollection. The appended reset-boundary migration fixes that FK and adds a unique product checkpoint with a deletion tombstone, plus token-fenced UTC leases. Job/rows insert atomically; worker reads pages of 25, resolves brand/collection once per page and avoids response media hydration. A stopped worker resumes canonical post-commit work on the same saved product. Production retry enqueue failures remain visible. BullMQ colon-containing custom IDs are corrected. Input/row errors and subset retry counters are preserved. Actual PostgreSQL fixture passes seven cases, including 26 products/two context reads, interruption recovery and lock-wait expiry; cleanup passes. Store tests passed; collection suite passed after correcting its stale non-UUID cursor fixture. Overall bulk-command entries stay open until remaining taxonomy/index/side-effect reads receive semantic closure.

New files: src/collections/bulk-import-query.ts; scripts/verify-bulk-import-postgres.cjs; prisma/migrations/20261023120000_bulk_import_store_checkpoint/migration.sql; docs/operations/BULK_PRODUCT_IMPORT.md; docs/performance-reviews/bulk-import-postgres-2026-10-23.json. Also changed prisma/schema.prisma and collections.controller.ts. The fixture is included in both backend quality workflows, which have not been dispatched.

## Mixed scheduled events, in verification

Added a 25-event path sharing joined recipient preferences/suppression/actors and per-event candidate/target/patch-relationship reads. Payload, actor, type, dedupe window and target remain distinct per event. Same-recipient writes preserve serial duplicate handling without rereading policy. The actual PostgreSQL mixed-event check passes with five SELECTs for 26 events including the assertion; the fixture exposed a boolean parameter inference error, fixed with explicit SQL casts. Additional real patch-privacy and scheduler checks are being completed. Do not yet treat every converted caller as certified.

Changed caller files: src/brand-verification/physical-verification-cron.service.ts; src/brand-verification/brand-verification-cron.service.ts; src/admin/featured/admin-featured.service.ts; src/admin/featured/featured-auto-removal.service.ts; src/collections/collection-scheduler.service.ts. New scheduler coverage: src/notifications/scheduled-notification-batching.spec.ts. Updated src/admin/featured/featured-expiry.spec.ts and src/collections/collections.service.spec.ts. Featured/cleanup 11 runtime checks pass; mixed helper/collection 35 runtime checks pass. A full current-source typecheck remains required after the latest caller edits.

Mixed-event verification follow-up: actual PostgreSQL fixture now passes eight scenarios, including 25 distinct actors with only eight SELECTs (five are shared canonical actor/profile/file/brand hydration, plus policy, patch relationship and assertion). Actor hydration is bounded ORM batch reads, not per-event queries. Three focused runtime suites pass 35 tests (review lifecycle, scheduler callers and notification batching). Earlier featured/cleanup 11 remain passed. Inventory now FIXED66/policy22/stateful49; 71 entries remain open. ReviewsService.processDueReviewReminders and SizeFitService.sendDueUpdateReminders also use mixed events while preserving exclusions, errors and refresh counters. No claim of exactly-once cross-worker notifications has been made.

## 24 October — bulk product recovery projection

Fresh import rows reuse product scalar values and the membership just written
in the same transaction. They do not reload brand/variant/display relations that
the import response does not use. Recovery uses one PostgreSQL LATERAL JOIN for
the current product, every membership and latest review submission. Independent
lateral subqueries prevent relation row multiplication. Scalar timestamps retain
their Date/UTC representation. Missing, deleted, archived or wrong-brand products
retain the existing recovery refusals.

Checkpoint identity now comes from the existing locked job read, removing the
second lookup of that same job within each product transaction. The job-before-row
lock order and fresh post-wait UTC lease check remain authoritative; this reuses
locked values rather than a pre-lock snapshot.

The actual PostgreSQL fixture passes eight scenarios with disposable-database
cleanup. Its26 draft products use two brand-context reads, zero product display
reloads and zero checkpoint-identity reloads. The separate recovery projection
uses one actual SELECT, including multiple memberships and review submissions.
Replay, post-commit interruption, deletion tombstones, malformed rows, competing
leases and expiry during a lock wait remain covered. Backend TypeScript passes;
the store, collection and bulk-unpublish suites pass53 tests. These measurements
do not certify active-product import, external notification delivery or the entire
remaining inventory. Entries55/56 stay open for taxonomy/index/side-effect closure;
the71-open count has not been reduced from this partial fix.

Changed: src/collections/bulk-import-query.ts, src/store/store.service.ts,
scripts/verify-bulk-import-postgres.cjs and its evidence JSON.

## 24 October — standard-order SLA notification findings closed

Frozen entries106/108/109/110 now use the mixed-event path; the overdue builder
does no database work. Twenty-two scheduler/helper tests pass, including exact
order links, per-order recipient deduplication, disabled-engine no-op, missing
owner/payment date, failed-recipient continuation, one-hour escalation windows,
closed business hours and notification of only the winning guarded cancellation.
The actual shared PostgreSQL fixture passes eight cases with cleanup:26 mixed
events use five SELECTs;25 distinct actors with patch privacy use eight SELECTs.
These include assertion reads and the shared actor/profile hydration queries.
Financial provider/refund correctness remains a separate open release item.

The frozen178-entry inventory now has70 fixed entries,18 open recipient-policy
entries and49 open stateful entries:67 remain open. Bulk55/56 remain open despite
their measured partial improvements above. Both backend quality workflows already
include the scheduler/helper tests and actual PostgreSQL fixture; this resumed
work has not been committed or deployed.

## 24 October — first-publication alerts and message dispatcher review

Product publication alerts are first-publication-only, including a handled empty
audience, as confirmed by the owner. Immediate and scheduled publication share
current Product/Brand/User JOIN eligibility; null schedules are included so a
failed immediate handoff can recover. Accepted patchers are keyset-paged500 across
distinct owners and reused for products of the same brand. Queue and fallback
share deterministic per-recipient identities. Durable replay checks are loaded25
at a time rather than adding a read for each recipient. Failed handoffs/scans stay
pending; successful and empty-audience products receive one conditional marker
write. See operations/PRODUCT_PUBLICATION_ALERTS.md for behavior and rollout order.

Frozen140 is closed for its read fanout. Actual PostgreSQL:26 products share two
metadata/audience SELECTs; republishing does not enqueue again; future/deleted/draft
products and pending/brand/self connections are excluded. Durable26-recipient
fanout uses two replay lookups and retries insert no extra notifications. The
six focused suites pass100 tests. Backend semantic typecheck passes.

Frozen102 is a reviewed leased queue command in current source. A single atomic
claim supplies each row; independent token-fenced completion/failure writes are
required, with no recipient hydration here. Two competing actual dispatchers use
two batch claims, zero standalone SELECTs and one stable handoff per row. Ten
existing side-effect tests pass. The expanded shared PostgreSQL fixture passes25
scenarios with cleanup; queue/provider calls are captured, not live delivery.

Inventory remains178 candidates:88 fixed-after-capture,43 stateful entries still
OPEN. No recipient-policy category remains open. This is not a full N+1, race or
scaling sign-off. Audience edits during sweeps, channel side-effect recovery and
exhausted jobs remain later review gates. Item1 remains held; no new deployment.

Bulk55/56 are still OPEN. Their latest partial taxonomy work reads current
collection/category/type state in one JOIN after the collection lock and reuses
that snapshot in import-only validation, without sharing it across rows. Actual
bulk fixture passes9 scenarios (26 drafts,26 post-lock taxonomy JOINs, no duplicate
category delegate reads, two page contexts, no display/checkpoint reloads),
including a real lock wait followed by category deactivation. Store/collection/
taxonomy suites pass57 tests. Index/filter/postcommit semantics still need review.

## 24 October — bulk checkpoint pipeline reviewed

Frozen55/56 now use a specifically reviewed checkpoint command classification.
Brand context is shared per25-row page; fresh scalar/checkpoint values are reused,
recovery projects memberships/latest submission in one JOIN, and taxonomy is
read once after the collection lock. Slug selection returns one scalar while
preserving earliest suffix gaps, including over1,000 matching rows. The initial
SQL gap test exposed substring parameter overload ambiguity; explicit integer
casts corrected it before the final actual PostgreSQL run.

Recovery uses persisted owner-edited tags and product names. Review-submission
notices defer to a page flush through shared createEvents policy/replay batches;
product-publication metadata/audiences also share that flush. Stable submission
UUIDs prevent repeated review notices. Rows become SUCCESS after the flush has
been attempted, preserving the existing best-effort review-notification failure
policy; infrastructure interruption before the flush leaves checkpoints unfinished
and recoverable. Canonical tag, price-range and product write-time guards remain.

Actual PostgreSQL passes13 scenarios with cleanup:26 drafts/two brand contexts,
zero response/checkpoint reloads,26 post-lock taxonomy JOINs, one recovery JOIN,
one scalar slug probe,26 recovered review notices/two policy reads and two
publication metadata plus two audience reads. Replays create no duplicate review
notices. Five affected suites pass81 tests; backend types pass. The final combined
regression is tracked separately. The original178-candidate inventory now has41
OPEN stateful reviews. No release, complete race audit or capacity certification
is implied. Historical earlier OPEN counts above remain source-stage records.

Final combined verification at this source stage:11 suites/169 tests pass; backend TypeScript and both workflow YAML checks pass. The shared PostgreSQL fixture passes25 scenarios and the bulk fixture13, both with cleanup. These are local/disposable-database results; no new deployment or live notification-provider delivery was performed.

## 24 October — file cleanup and fresh email guards

Frozen103 now uses a shared bounded deletion transaction. Two SELECTs process26
unused message files; one INSERT SELECT UNION/JOIN queues78 original/variant keys.
No storage call runs in the metadata path. Locks precede a fresh reference check,
including nullable/implicit relations; ownership, processing leases and required
published product views remain protected. Product unlink retains shared files.
The13-case actual PostgreSQL fixture passes with cleanup, including rollback,
outbox failure, competing workers and both foreign-key lock race orders. See
operations/FILE_DELETION.md for the changed deletion/physical-removal contract.

Frozen104 retains one fresh suppression lookup per independently claimed email
attempt; that guard belongs immediately before transport. Current code has no
emailDeliveryAttempt.count in this path.26 suppressed attempts use one due scan
and26 guards, write26 audit records, complete the blocked rows and make zero
transport calls. Sweep size is clamped at150 and concurrency stays10. Email
claim/recovery/completion fencing remains an item3 finding. These tests prove
suppression against PostgreSQL, not provider delivery.

Six focused suites/86 tests and backend TypeScript pass. Both workflow commands
include the new coverage and the disposable PostgreSQL fixture. The original178
candidates remain present;39 stateful reviews remain OPEN. No new release or
application database reset occurred. All four clients use the shared backend;
no client UI or device verification was performed at this source stage.

## 24 October — grouped push badges, fresh device checks

Frozen105 is now individually reviewed after incidental badge reads were grouped.
The100-row sweep has ten-way groups, each using one aggregate over distinct
recipient IDs; no matching unread rows produce zero, failed optional reads omit
the badge, and each later group refreshes the snapshot. Token eligibility stays
a fresh per-attempt read after the claim.26 attempts use one due scan, three
badge aggregates and26 token checks. The actual SDK rejects synthetic invalid
tokens before transport; inactive tokens are excluded.

The15-scenario disposable PostgreSQL run also exercises the real installed Expo
HTTP client against local Postman: three messages through two send requests,
badges0/1 and payload preserved, three pending receipts. Owner mock discovery was
unavailable while the CLI was signed out; the stand-in follows the official Expo
send/ticket contract. CI runs DB/no-transport checks; the wire test requires the
explicit local simulation URL. Twelve push tests pass; combined affected coverage
is98 tests across eight distinct suites, with backend types passing. This does
not prove FCM/APNs/device delivery, worker fencing or production capacity.

The frozen178-candidate inventory now has38 OPEN stateful reviews. See
operations/PUSH_OUTBOX_QUERY_POLICY.md for behavior and repeatable commands.

##25 October — financial and refund query continuation

Immutable settlement snapshots now insert/return100 at a time;26 fresh standard orders need one snapshot INSERT/no snapshot or immediate hold reloads. Delivery timeouts share one200-row hold/order/snapshot JOIN;102 operator records need two inserts/zero SELECTs. Existing per-journal locked balances and per-payment receipts remain distinct. Actual database execution caught/corrected the mapped settlement_policy table identifier. See operations/SETTLEMENT_QUERY_POLICY.md.

Refund attention now reads one narrow current refund/shopper JOIN after a winning transition, preserving transactional alerts/events/outbox and returning only actual transition counts. Compensation capture and attention use scalar current capture/invoice/agreement JOINs with native Decimals and no authorization hydration. Interrupted submission paths make zero provider calls. Eight focused suites95 tests, types/lint and real PostgreSQL20 financial/compensation plus5 issue/refund cases pass with cleanup. Provider polling/submission, general races and currency isolation remain separate gates. Original178 retained;27 stateful reviews OPEN.

##25 October — current queue capacity and financial context

Capacity guards now use one indexed relational projection, retaining current brand/owner/agreement/tier/campaign state without eager hydration or cross-transaction caching. Financial order guards use one scalar order/brand/owner JOIN after the existing brand lock. Actual PostgreSQL10 scenarios cover boundary/null/zero/campaign/suspension states,26 held waiting captures, real2Active/1UpNext drain, real timeout completion/final posting and a cursor sweep. Expired plans block new intake while existing paid work can progress. Queue/cron/intake47 and customfinance7 tests, backend types and new helper lint pass. Original178 candidates retained;21 stateful reviews remain OPEN, with sibling cancellation/jump/provider gates separate. See operations/QUEUE_CONTEXT_QUERY_POLICY.md.

##25 October — cancellation, priority and subscription reconciliation

Cancellation now shares its guarded mutation without unused bulk/expiry response hydration; current order/owner comes from one JOIN. Priority allocations insert without existence reads and preserve paid state on replay. Actual issue/refund/queue13cases pass. Billing context uses narrow invoice/identity and current renewal/debit/source/card JOINs;25 paid references share one receipt SELECT. Actual PostgreSQL29cases include7contract-based local Postman HTTP scenarios:26renewals78requests/26confirmed captures, safe replay, pending/unknown/outage/identity/card/cancellation checks.21subscription and28queue unit tests, types and changed-helper/source lint pass. Frozen178 retained;13 reviews remain OPEN. No live-provider/device or whole-race certification. See operations/QUEUE_CONTEXT_QUERY_POLICY.md and SUBSCRIPTION_QUERY_POLICY.md.

##25 October — standard SLA refund context

One scalar current order/capture JOIN replaces separate context reads; native Decimal and missing-record distinctions retained. The actual SLA cron on26test-mode orders performs26JOINs/26escrow+ledger refunds and52recipient event handoffs; repeat adds no refund money. Overall31PostgreSQL scenarios pass/cleanup, including the earlier7subscription HTTP scenarios. Standard live-refund transport was not exercised and existing provider-inside-transaction/whole-parent semantics remain a separate canonical refund gate. Frozen178 retained;12reviews OPEN.

##25 October — grouped recovery and debt context

Admin recovery is grouped by brand/currency: actual26NGNallocations read debts once and create one219payout after15recovery, replay without duplicate money. Shared scalar debt aggregate/owner projection returns one row rather than a full debt list plus owner read; credit/default/recipient behavior verified. PostgreSQL15issue/queue/debtcases pass/cleanup; source lint/types pass. Currency isolation, recovery locking and notice commit ordering remain separate unresolved gates. Frozen178 retained;11reviews OPEN. See operations/DEBT_QUERY_POLICY.md.

##25 October — paid custom-order admission metadata

Placement/expiry notices reuse owner from the current capacity JOIN, avoiding two standalone Brand reads per admission. Initial routing projects only brandId; current financial/buyer/entitlement/FIFO guards remain. Actual26admissions under parent-capture lock:zero standalone Brand SELECTs,26held captures at cap0,52placement/156reminder records and safe replay. Queue28tests/types and actualPG16cases pass/cleanup. Frozen178 retained;10reviews OPEN; upstream full checkout/provider gates remain separate.

##25 October — payment current-row locks and receipt replay

A shared SELECT FOR UPDATE now locks and returns the PaymentAttempt in one roundtrip. Actual26stale expirations require one shared scan plus26locked reads, with no standalone current-row reloads. Current buyer/system/terminal/FX/order/event semantics and wait-after-competing-write behavior verified. Stored receipt replay already shares identity scans;26terminal events process then0onrepeat without duplicate transition.41payment/custompayment tests/types/newhelperlint and PostgreSQL34cases pass/cleanup. Full provider-success/custom/unified paths remain separately OPEN. Frozen178 retained;8reviews OPEN. See operations/PAYMENT_QUERY_POLICY.md.

##25 October — queue refund context

Frozen reviews74/75 now verified: one native current refund/capture/order JOIN replaces eager nested relation reads, with one bounded20-sibling callback query. ActualPG19cases/cleanup,17unit/backend types/lint pass. Reservation/ledger/recipient/replay and current lease protections retained. Live provider/signature/fencing gates remain separate. Original178 retained;6reviews OPEN. See operations/REFUND_QUERY_POLICY.md.

##25 October — custom-payment reconciliation

Candidate64 verified after authorized attempt reuse and current native order/owner/buyer-name JOIN.26actual cron captures use local provider HTTP, real queue/finance/receipt/message/outbox persistence; replay and failure/isolation checks pass.21PGcases cleanup/9unit/types/lint PASS. Original178 retained;5reviews OPEN. Live provider/device delivery and broader races/canonical contraction remain separate.

##25 October — standard successful payment context

Candidate114 verified after native order/owner JOIN and real26capture HTTP/finance/notice/message proof.35PGcases cleanup/41unit/types/helperlint PASS. Fresh independent notification actor guards retained and measured. Frozen178 retained;4reviews OPEN.

##25 October — unified checkout query review

Candidate115 verified with native current session lock/read, selected standard owner JOIN and shared custom metadata scans; per-order capacity-changing commands retained. ActualPG25cases cleanup/41payment+6bag/types/helperlint pass. Real fresh-checkout cart-lock driver error corrected and tested under competing lock. Frozen178 retained;3reviews OPEN.

##25 October — product archive

Archive commands now load narrow current product-owner JOIN and current collection/wishlist JOIN; bulk skips discarded response hydration/signing, public response retained. Actual26 archives plus duplicate/missing/mixed refusal,60day expiry, tag removal, price recomputation, correct wishlist notices and real owner permission/refusal/replay verified. Fresh independent notification identity file reads retained(52), not claimed removed. Actual PostgreSQL15cases/cleanup/types/helperlint PASS. Frozen178 retained;2reviews OPEN.

##25 October — product unpublish

Bulk metadata/permissions already shared. Each independent update now reuses its written scalar row plus current membership IDs instead of full brand/variant/media response reload; fresh taxonomy validates through one JOIN per guarded mutation. Tags, current price ranges, permission/archived/deleted guards and mixed results retained. Actual26 categorized updates/replay/isolation/precision verified; no response signing. Actual PostgreSQL16cases/cleanup/types/helperlint PASS. Frozen178 retained;1reviews OPEN.

##25 October — product delete

Deletion uses current product-owner JOIN, current membership effects JOIN and database product-specific active-order lookup rather than hydrating/scanning all brand orders. Bulk retains independent authorization/transaction/effects and partial failures. Actual26 deletions/tags/cart/memberships/price updates/replay, normalized versus old-item guard and foreign actor checked. Canonical provider refund behavior remains separate gate5; this query review does not certify a refund. Actual PostgreSQL18cases/cleanup/types/helperlint PASS. Frozen178 retained;0reviews OPEN.
