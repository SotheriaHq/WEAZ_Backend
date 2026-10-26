# Refund and compensation query policy

Refund attention first wins its conditional state transition. It then reads only
the current custom-order ID, payment ID and shopper ID through one refund/order
JOIN, within the same transaction. It does not hydrate the payment payload or
the complete order. Alert, payment event, timeline and notification outbox writes
remain atomic with that transition. A refused claim performs no context read or
duplicate side effects; the sweep reports only successful transitions.

Subscription compensation retains a fresh capture read after its claim and a fresh
context read inside an attention transaction. Both now use one scalar JOIN across
capture, invoice and agreement. Money remains native Decimal; saved authorization
data is not loaded. Financial inbox/email receipts still use the existing current
brand-owner/email JOIN and stable idempotency keys inside the financial transaction.
Receipt recipients are not cached across independent capture transactions.

The actual PostgreSQL fixtures cover26 stale refunds, shopper isolation, refused
claims and real durable-event failure rollback, plus26 interrupted subscription
refunds that require attention without resubmission. They verify unchanged paid
periods, exact Decimal context, no repeated receipts and zero provider actions on
these guarded paths. No callback/provider request is simulated by these DB checks.

This closes only the scoped query reviews. Provider submission and polling,
signature/identity validation, uncertain-outcome recovery, lease/fencing races,
currency/debt isolation and device delivery remain separate release gates.
Subscription tier definitions and access policy are unchanged.

These shared backend paths serve desktop, tablet, browser-mobile and native records.
No client layout, notification-permission UI or device behavior changed here.

## Standard-order refunds (canonical since 26 October)

Every standard refund (return, SLA timeout, admin SLA cancellation, product
deletion) is a durable `StandardOrderRefund` row: one per order, for that
order's own share of the capture, never the whole parent. A request locks the
capture (`SELECT … FROM "PaymentAttempt" WHERE reference = $1 FOR UPDATE`), then
the order and the escrow hold, inside the caller's transaction. It never
contacts the provider. Submission, polling and completion run later, outside
every lock, through one provider client. An uncertain outcome is looked up by the
refund's merchant note and is never resubmitted. Operator procedures:
[STANDARD_ORDER_REFUND_RUNBOOK.md](STANDARD_ORDER_REFUND_RUNBOOK.md).

The SLA cron on 26 independent captures performs 26 capture locks, 26 escrow
reservations and reserve journals, and pending-refund notices for 52 recipients.
Replays converge on the same refunds, and no settlement journal exists before the
provider confirms (`verify-ledger-concurrency.cjs`). Provider transport,
webhooks, lost answers, stale leases, lease loss, definitive rejection, admin
reconciliation and product removal run against a loopback Paystack-shaped
simulator (`verify-standard-refund-integrity.cjs`). An order without a payment
reference is refused (`ORDER_CAPTURE_REQUIRES_REVIEW`). Paid orders are created
with the capture reference, and no legacy rows exist on local or SIT.

## Queue refund and callback context

Submission, reservation, polling and completion now use a narrow native refund/capture/order JOIN. Each refund retains its independent authoritative claim and financial transaction; no batch cache crosses those boundaries. A reference-only callback reads at most20 matching PROCESSING siblings in one JOIN, scoped to gateway; a provider-ID callback reads its own identity. Decimal and date fields remain native.

Actual PostgreSQL19cases pass with cleanup:26internal-simulation refunds use78JOINs and zero eager payment/order hydration, preserve parent PAID status and correct shopper notices, and replay safely. Equal-priced sibling callback, wrong gateway/missing ID, current poll lease, provider-ID replay and wrong amount attention are verified.17unit tests and full backend types/lint pass. This proves database behavior and trusted callback handling, not incoming signature transport, live provider acceptance or lease fencing.
