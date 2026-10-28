# Standard-order refunds — operator runbook

For on-call engineers and finance admins. It covers refunds of standard (shop)
orders through `StandardOrderRefundsService`. Custom-order queue refunds follow
the same states in their own table, `CustomOrderQueueRefund`.

## What happens to a refund

1. **Request.** A buyer return, the SLA timeout cron, an admin SLA cancellation
   or a product deletion calls `requestInTransaction` inside its own order
   transaction. One `StandardOrderRefund` row exists per order, so concurrent
   triggers converge on it. The request:
   - moves the escrow hold to `REFUND_PENDING`, so no release can run;
   - posts the reserve journal (escrow, released commission and released brand
     money → `SYSTEM:REFUND_PAYABLE`);
   - records any released brand money once, as a `REFUND_CLAWBACK` row keyed
     `standard-order-refund:<refundId>`.

   No provider is contacted. The order is cancelled, and its payment stays
   `PAID`. The shopper is told the refund "has been requested and is being
   processed".
2. **Submission.** The every-minute tick runs outside every database lock. It
   claims the row with a lease token and verifies the original capture
   (`GET /transaction/verify`). It then submits `POST /refund` for the order's
   own share, with the merchant note `WIEZ standard refund <refundId>`. The
   row becomes `PROCESSING` and stores the provider refund id.
3. **Completion.** A signed Paystack refund webhook or the five-minute poll
   re-reads the refund from the provider. Only when the provider reports
   `processed` does one transaction:
   - mark the hold `REFUNDED`;
   - post the `REFUND_ISSUED` journal;
   - set the order to `paymentStatus=REFUNDED`, which removes it from customer
     counts;
   - resolve any open alert.

   The shopper's "refund processed" notice is sent after commit, once per
   refund (`buyerNotifiedAt`).

Every money command locks in this order: capture → order(s) → escrow hold →
refund row → brand → debt rows → ledger accounts (code, currency) → payouts.

## States

| Status | Meaning | What runs automatically | What a person does |
| --- | --- | --- | --- |
| `REQUESTED` | Reserved, not yet sent | Submitted on the next tick | Nothing |
| `SUBMITTING` | A worker holds the lease and is talking to the provider | After a 10-minute lease the provider is searched by note; never resent | Nothing, unless it reaches `NEEDS_ATTENTION` |
| `PROCESSING` | The provider accepted it; the refund id is stored | Webhook or poll settles it | Nothing |
| `SETTLED` | The provider processed it; money, hold and order are final | Shopper notice | Nothing |
| `FAILED` | Definitely not created (HTTP 400/401/403/404/422, capture check, credentials, mode) | Retried with backoff (1 min × 2^attempts, at most 24 h), five attempts, then `NEEDS_ATTENTION` | Fix the cause (key or mode mismatch) if it repeats |
| `NEEDS_ATTENTION` | The outcome is uncertain, or the provider failed it | **Nothing. It is never resubmitted.** | Reconcile (below) |

## Reconciling `NEEDS_ATTENTION`

Each one opens an `OperationalAlert` with
`dedupeKey = standard-refund:<refundId>:attention` and the reason in
`metadata.code`:

- `REFUND_GATEWAY_OUTCOME_UNKNOWN`, `REFUND_GATEWAY_RESPONSE_UNCERTAIN`,
  `REFUND_GATEWAY_HTTP_5xx`: the answer was lost, and the provider search by
  note was unavailable or found nothing.
- `REFUND_SUBMISSION_LEASE_LOST`: the provider answered after the lease
  expired. Its refund id is already stored on the row.
- `REFUND_PROVIDER_FAILED`, `REFUND_PROVIDER_NEEDS_ATTENTION`: the provider
  reports the refund failed.
- `REFUND_STATUS_RESPONSE_MISMATCH`: a status answer did not match the
  capture, amount or currency.
- `REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED`: a mock capture outside an
  enabled local test environment.

To reconcile:

1. Do not send another refund from code.
2. In the Paystack dashboard, open the capture reference, list its refunds,
   and find the one whose merchant note is `WIEZ standard refund <refundId>`.
3. If it exists, call
   `POST /admin/orders/refunds/:refundId/reconcile` with body
   `{ "providerRefundId": "<id>" }`. This needs the Admin or SuperAdmin role,
   the `payouts.process` permission, and stays within 10 requests a minute.
   The server fetches that refund and checks its transaction, amount and
   currency before linking it. It never sends a refund. If the refund is
   already processed, it settles immediately; otherwise the webhook or poll
   finishes it.
4. If no refund exists, or the provider failed it, create the refund in the
   Paystack dashboard for the exact amount and currency on the row, with the
   same merchant note. Then reconcile it with its new id, as in step 3.
5. Errors from the reconcile route:
   - `REFUND_PROVIDER_RECONCILIATION_MISMATCH`: the id belongs to another
     capture, amount or currency.
   - `REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE`: the provider lookup failed.
     Retry.
   - `REFUND_RECONCILIATION_STATE_CHANGED`: the row moved, or holds a
     different id.

Until the refund settles, the money stays reserved: the hold remains
`REFUND_PENDING`, nothing is released to the brand, and the order is not
counted as refunded.

```sql
SELECT id, "orderId", status, "lastError", "providerRefundId", attempts, "updatedAt"
FROM "StandardOrderRefund"
WHERE status IN ('NEEDS_ATTENTION', 'FAILED')
ORDER BY "updatedAt";
```

## Webhooks

Paystack refund events carry `data.transaction_reference`, without a refund
id. They match up to 20 `PROCESSING` refunds of that capture, and each one is
re-read from the provider before anything changes. A payload carrying
`data.id` matches by provider refund id. Webhooks reach this code only after
`PaymentService` has verified the signature. A unified capture is offered to
both the custom-order and standard-order engines, and each acts only on its
own rows.

## Brand money

A brand's position is computed per settlement currency (NGN):
released escrow and eligible custom earnings, minus reserved and paid
payouts, minus manual debits and chargebacks, plus manual credits. Holds that
are `REFUND_PENDING` or `REFUNDED` no longer count.

- Debt is the negative part of the position.
- A `REFUND_CLAWBACK` row says why the position fell. It is not a second
  charge.
- When the position recovers, open debts are marked paid oldest-first, with
  one `BrandBalanceRecovery` line per settling order ("Settled from the brand
  balance").
- Released money that the brand had not yet withdrawn returns at once, without
  leaving a debt.
- Owner notices (`BRAND_BALANCE_ADJUSTED`) are sent after commit, once per row
  (`announcedAt`).
- Custom-order earnings in other currencies are reported separately. They are
  not payable until settlement conversion (item 6).

## Product deletion

- Shipped orders block deletion (`PRODUCT_HAS_SHIPPED_ORDERS`). Archive the
  product instead.
- A checkout in progress blocks deletion with `PRODUCT_CHECKOUT_IN_PROGRESS`.
  That means a session awaiting payment that has not expired, or a payment
  still being confirmed within 24 hours.
- With `cancelPendingOrders=true`, unshipped paid orders are cancelled and
  their refunds requested as above. Without it, the call is refused.
- Checkout locks each product and re-checks it after the lock, so a deleted,
  archived, inactive or unpublished product cannot be bought.

## Mock captures

A capture in `mock` mode never reaches a provider. It settles only when
`NODE_ENV` is `development` or `test` and
`STANDARD_ORDER_REFUND_SIMULATION_ENABLED=true`. Never set that flag on SIT
or production.

## Evidence

`scripts/verify-standard-refund-integrity.cjs` runs in CI against disposable
PostgreSQL and a loopback Paystack-shaped simulator, with synthetic keys only.
Its result is recorded in
`docs/performance-reviews/standard-refund-integrity-postgres-2026-10-26.json`.
