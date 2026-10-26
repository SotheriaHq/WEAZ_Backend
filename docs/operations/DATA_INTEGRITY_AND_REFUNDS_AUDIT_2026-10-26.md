# Data integrity and canonical refunds — audit and plan (26 October 2026)

Scope: relational integrity/normalization (ledger, debt, escrow, orders, tags,
store-collection membership, reference seeds) and the refund, cancellation and
product-deletion money flows. Evidence is from source at backend
`67bf6b8` (branch `release/r2-fresh-regression-20261023`) and read-only,
aggregate-only catalog/data queries run separately against the local database
and the SIT database on 26 October 2026 (13:10 UTC). No row data, identifiers
or credentials were printed.

## Starting state (verified)

| Item | Local | SIT |
|---|---|---|
| Deployed/checked-out backend | `67bf6b8` (5 commits ahead of origin, clean tree) | `fc37166` on `SIT` |
| Applied migrations | 143 (repo has 148; 5 newer migrations not applied) | 143 |
| PostgreSQL | 17.6 | 15 (box) |
| Tables / FKs / CHECKs | 192 / 290 / 13 | 192 / 290 / 13 |
| Transactional rows (orders, payments, ledger, debt, payouts, refunds, tag bindings, products) | 0 | 0 |
| Reference seed counts (tags, measurement points, charts, versions, categories, sub-categories, tiers, filters) | 130, 38, 46, 45, 13, 67, 4, 6/75 | identical |

Both databases were reset earlier; there is no transactional data to repair.
Every finding below is therefore a schema or code defect that would corrupt
new data, and the fixes are forward migrations plus code. 46 charts versus 45
versions is by design: the NG_WEST_AFRICA support-policy record is metadata
only.

## Findings (severity ranked)

Each finding lists the invariant, the evidence, the affected flow and the
correction. "Snapshot" marks deliberate immutable history that must be kept.

### Critical — money or state corruption on reachable paths

**C1. Order reads rewrite payment status.**
Invariant: a refunded order stays refunded; a status is never moved by a
stale read. Evidence: `common/payments/order-payment-reconciliation.util.ts`
runs on every buyer/brand/admin order list and detail read. It maps the
capture status to the order with an unconditional `update`. `REFUNDED`,
`REFUND_IN_PROGRESS` and `PARTIALLY_REFUNDED` captures map to `PENDING` (and
clear `paidAt`); a refunded order on a still-`PAID` unified parent capture is
rewritten back to `PAID`. Effect: refunds disappear from the UI and the
customer-count rule (paid, not cancelled, not fully refunded) re-counts
refunded shoppers. Correction: never move an order out of `REFUNDED`; treat
refund-stage capture statuses as captured money; conditional writes guarded by
the observed status.

**C2. Standard refunds use the whole parent capture, inside a database
transaction.** Invariant: one order's refund equals that order's share of the
capture; provider calls never run while row locks are held; an uncertain
provider outcome is never resubmitted. Evidence: `order/order-refund.service.ts`
refunds `attempt.amount` (the whole unified capture, which can include other
brands' orders and custom lines), marks only one order and one escrow hold
refunded, then any sibling refund sees the capture `REFUNDED` and is marked
refunded with no escrow or ledger effect. The live HTTP call has no timeout,
runs inside the caller's transaction, and on any error the capture is reset
to `PAID` from a second connection (which waits on the row lock the
transaction holds), so a refund the provider accepted can be sent again.
Test-mode captures are marked refunded without a provider call. Callers:
`OrderService.updateStatus(RETURNED)`, `cancelOverdueOrderByAdmin`,
`OrderSlaCronService`. Correction: durable refund records and one canonical
engine (below).

**C3. Legacy custom-order refund branch can refund a whole unified capture a
second time.** Evidence: `custom-orders/custom-order-refund.service.ts`. The
queue service is always injected, so the legacy branch only runs when the
custom order is already `REFUNDED`; when its unified parent capture is still
`PAID` (by design, other lines remain) the branch claims the parent and sends
a live refund for the whole capture from inside the caller's transaction.
Correction: an already refunded order is an idempotent no-op; the legacy
HTTP branch is removed in favour of the canonical engine.

**C4. Product deletion invents refunds.** Evidence:
`store/store.service.ts` `deleteProduct` with `cancelPendingOrders=true`
writes `status=CANCELLED, paymentStatus=REFUNDED` directly on every active
order containing the product: no provider refund, escrow or ledger effect;
whole multi-item orders; shipped orders; and it tells the shopper the money
was refunded. There is no product row lock, so a checkout can commit between
the read and the delete. Correction: product lock; unshipped paid orders are
cancelled through the canonical refund engine with pending wording; shipped
orders block deletion (archive remains available); in-flight checkouts block
until they expire; checkout re-checks sellability after its product lock.

**C5. Ledger account identity ignores currency.** Invariant: an account holds
one currency; every entry's account currency equals its transaction currency.
Evidence: `finance/ledger.service.ts` uses currency-free codes
(`SYSTEM:GATEWAY_RECEIVABLES`, `BRAND_WALLET:<brandId>`), creates every
account with `currency='NGN'`, and posts transactions in their own currency,
so a USD posting adds its nominal amount to an NGN balance. Monetary values
pass through JavaScript numbers. Correction: account identity is
`(code, currency)`; exact Decimal amounts; database triggers reject
cross-currency entries and unbalanced transactions at commit.

### High

**H1. Escrow hold transitions are unlocked.** `standard-order-escrow.service.ts`
reads then updates holds by id with no row lock or status guard. A final
release racing a refund debits escrow twice and leaves the released amount
unclawed. Correction: every transition locks the hold row first.

**H2. Debt and credit records are not financially consistent.**
`finance/brand-balance.service.ts`: duplicate clawbacks under concurrency
(find-then-create, no unique key); recovery with no locks writing absolute
values from a stale read; no currency filter (an NGN release pays a USD debt);
`number` arithmetic; owner notices sent before the enclosing transaction
commits; manual credits never consumed; recovery only runs in the admin
custom-order release, so the recorded outstanding debt diverges from the
payout balance, which already nets refunds. Manual debits, credits and
chargebacks do not affect the payout balance at all. Custom partial refunds
mutate an existing adjustment's amount. Correction: the payout balance is the
single source of what a brand can withdraw; debt is the negative part of that
balance; adjustment rows are an immutable statement with unique source keys;
recovery is reconciled first-in-first-out under the brand lock.

**H3. Payout balance mixes currencies.** Custom-order earnings are stored in
the shopper's order currency while the payout balance sums them without a
currency filter and pays them out as `NGN`. Correction (item 4): filter to
the settlement currency and report other-currency earnings separately.
Converting custom settlement to NGN at the original payment rate is item 6.

**H4. Standard refund webhooks are dropped.** Paystack refund webhooks carry
`data.transaction_reference`, not `data.reference`; only custom queue refunds
have a handler, so standard refunds have no completion signal. Correction:
the canonical engine routes refund webhooks by transaction and polls each
stored provider refund.

**H5. FX unified checkout over-funds standard escrow.** When the capture
currency differs from NGN, `StandardOrderFinanceSyncService` spreads the whole
capture's NGN settlement over the standard orders only, including any custom
lines' share. Correction: each order's NGN amount is its share of the
capture at the original snapshot rate.

**H6. Checkout does not re-check sellability under lock.** Reservation locks
tracked products but does not re-read deletion/archive/active state after the
lock; untracked items are not locked. Correction: lock every standard line's
product and re-check sellability after the lock.

**H7. Reference seeding overwrites administrative edits.** The deploy seed and
`CategoriesBootstrapService` (on every API and worker start) rewrite category,
sub-category and filter names/order/active flags, deactivate any filter value
an admin added, and rewrite measurement points an admin edited. Correction:
insert missing defaults only; explicit retired lists remain; seeded tags use
the runtime normalizer with a bounded rename of the previous stripped names.

### Medium

**M1. Tag binding discriminator and index order.** Store collections are
indexed as `COLLECTION` (the design type); `reindexAll` indexes designs only,
deletes every binding globally first, and applies stale prev/next deltas that
can leave bindings the source no longer has. `entityId` has no foreign key.
Correction: `STORE_COLLECTION` type for store collections (no existing rows to
convert); source-of-truth reconciliation per entity under the tag locks;
reindex without a global delete; generated typed foreign keys with
`ON DELETE CASCADE` remove orphan bindings.

**M2. Primary store-collection membership.** Product create and explicit
moves write `isPrimary` directly; store-collection soft delete leaves products
pointing at the deleted collection. Correction: one canonical writer; deleted
collections are skipped; a deferred database check keeps
`Product.collectionId` equal to the primary membership.

**M3. Order status transitions are not conditional.** `updateStatus` validates
then writes by id. Correction: conditional transition on the observed status.

**M4. Missing constraints.** Debt rows reference orders without foreign keys;
currencies are unchecked text; amounts are not constrained non-negative.
Correction: foreign keys (`NO ACTION`), currency format and amount checks.

### Deliberate snapshots and projections (keep)

- `Order.items` JSON is the purchase-time snapshot; `OrderItem` rows are the
  authoritative operational lines (all current orders are created with both).
- Settlement snapshots, escrow amounts and exchange-rate snapshots are
  immutable purchase-time terms.
- `Tag.usageCount`, collection price ranges and product tag arrays are
  projections recomputed under locks.
- `PaymentAttempt.orderIds` and old JSON-only order lookups are compatibility
  fallbacks retired under item 7 after callers are traced.

## Canonical refund flow (item 5 design)

One state machine for every refund: `REQUESTED → SUBMITTING → PROCESSING →
SETTLED`, with `FAILED` (definitely not submitted, retried with backoff) and
`NEEDS_ATTENTION` (outcome uncertain or provider failure; never resubmitted
automatically). Standard-order refunds get their own durable table with the
same states and constraints as the existing custom-order queue refunds; both
use one shared provider client (capture verification, submission, status
lookup, response identity checks, webhook routing and reconciliation).

1. Request (inside the business transaction, no network): lock capture, order
   and escrow hold; validate paid and not already refunding; amount is the
   order's own total in the capture currency and the hold's NGN amount at the
   original rate; create the refund row with a unique request key; move the
   hold to `REFUND_PENDING` so no release can run; reserve escrow to refund
   payable in the ledger.
2. Submission (worker, outside locks): claim with a lease and a unique owner
   token; verify the original capture with the provider; submit with a stable
   merchant note that carries the refund id; a definite rejection becomes
   `FAILED`; any uncertain outcome becomes `NEEDS_ATTENTION` and is matched
   later by listing the capture's refunds — never by sending another refund.
3. Completion (status poll or signed webhook): verify provider refund id,
   transaction, amount and currency; then, in one transaction locking refund,
   order, hold, brand and ledger accounts in that order, post the refund
   ledger entry, mark the hold refunded, record any clawback of already
   released brand money, set the order `REFUNDED` and enqueue the shopper's
   "refund processed" notice.

Lock order for every financial command: capture → orders (id order) → escrow
hold → refund row → brand → debt rows (created order) → ledger accounts (code,
currency order) → payout rows.

## Verification plan

Disposable loopback PostgreSQL databases only; a local synthetic provider HTTP
server stands in for Paystack. Scenarios: both race orders for refund versus
release, duplicate refund requests, concurrent buyer/admin/SLA/delete
triggers, crash after provider acceptance, timeouts, stale owners after lease
replacement, duplicate and out-of-order webhooks, wrong reference/amount/
currency/provider id, exhausted attempts, multi-order and mixed custom
captures, foreign-currency captures with NGN settlement, partial clawback with
insufficient earnings, concurrent debt recovery, ledger currency and balance
triggers, tag and membership invariants, and double seeding with edited
values. Each asserts row state, ledger balance, provider call counts, durable
events and customer aggregates.

## Not changed here

Custom-order NGN settlement conversion (item 6); removal of compatibility
fallbacks (item 7); client UI beyond refund-status wording; production
capacity; live provider or device delivery.
