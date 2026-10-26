# Subscription reconciliation query policy

Invoice verification and the initial payment-application lookup read one native
invoice/agreement identity JOIN. The projection includes only agreement brand
and payer-email fields; it does not hydrate stored authorizations. Payment
application still reloads the full current invoice/agreement after its brand
lock before changing entitlement.

Paid invoice verification loads the named capture receipts once, scoped to that
invoice, rather than issuing one receipt query per reference. Only PAID and
PAID_REVIEW invoices use this shortcut. A missing receipt still requires provider
verification. Pending references are never treated as failed or unpaid because
they were absent from the database. The map lives only for one verification call;
it does not authorize an entitlement mutation or a later charge.

Renewal preparation keeps the existing brand advisory lock and reads the current
agreement plus optional scheduled-tier price in one JOIN. Persisted integer NGN
prices, paid-period boundaries, current cancellation/recovery state and unique
invoice periods remain authoritative. A replay retains an already-created
replacement agreement's price when the tier catalog changes.

After checking all previously named provider references, an automatic debit reads
one fresh agreement/source-agreement/linked-card JOIN. It retains cancellation,
consent, recovery-deadline, authenticated stored authorization and card-owner
checks. This is separate from the earlier invoice read and is not cached across
provider requests. A card owned by another brand cannot authorize the debit.

The provider-reference loop is required reconciliation work: each prior reference
can represent a different external transaction. Missing or pending automatic
attempts block another debit. Confirmed captures retain their unique provider ID,
brand-locked application, immutable financial receipt and compensation rules.
No tier, customer definition or subscription entitlement rule was changed here.

## Verification

The disposable PostgreSQL fixture verifies25 paid references with one receipt
SELECT,26 agreement/scheduled-tier JOINs with zero tier reloads, immutable renewal
prices on replay and correct transactional recipient receipts.

The optional HTTP cases run the real SubscriptionPaystackService and actual
SubscriptionsService against the local Postman simulation. The modeled contract
comes from [Paystack transaction API](https://paystack.com/docs/api/transaction/)
and [payment verification guidance](https://paystack.com/docs/payments/verify-payments/).
Published-owner mock lookup was unavailable because the local CLI was signed out.
Orbit discovery returned unrelated APIs; those results were not used as a
Paystack contract. The local mock implements only verification and authorization
charge; unmodeled endpoints return501. Its fixture-control routes are test-only.

The checks cover definitive failure, unknown prior automatic attempts, pending
payments, amount/currency/email mismatch,503 recovery,26 automatic renewals,
repeat processing, a foreign-owner card and cancellation. The26-renewal cron case
makes78 HTTP requests:26 prior-reference checks,26 authorization submissions and
26 subsequent verifications. Repeating the cron makes no new provider request.
The same run uses52 scalar invoice identity JOINs and26 fresh debit context JOINs.
This proves the implementation against a contract-based local stand-in, not live
Paystack acceptance, real-card charging, webhook delivery or device notification.

Start the local simulation in a terminal inside the backend:

```powershell
postman simulation run postman/simulations/subscription-provider.sim.yaml --port 4917 --output ndjson
```

In a second backend terminal, run the existing disposable harness with the local
member URL. The scenario runner temporarily supplies synthetic credentials only
inside its own process and restores them afterward; no real keys are needed.

```powershell
$env:SUBSCRIPTION_PROVIDER_SIM_URL = 'http://127.0.0.1:4917/paystack'
node scripts/verify-ledger-concurrency.cjs
Remove-Item Env:SUBSCRIPTION_PROVIDER_SIM_URL
```

Stop the simulation with Ctrl+C. The runner rejects any non-loopback provider
URL and any database outside its randomly named disposable-test namespace before
performing fixture setup. The production provider endpoint remains unchanged;
the optional dependency-injection token SUBSCRIPTION_PAYSTACK_BASE_URL is used by
the test constructor, with https://api.paystack.co as the default.

Concurrency leases/fencing, broader currency/debt normalization, live-provider
regression and final deployment remain separate gates. Existing CI still runs
the database checks; the optional Postman HTTP run must be enabled explicitly.
