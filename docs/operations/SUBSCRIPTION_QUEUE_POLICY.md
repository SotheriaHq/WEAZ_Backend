# Subscription and custom-order queue policy

Updated: 2026-10-23. Business specification: version 1.4.

Every brand uses the same paid subscription rules. Account age does not grant free custom-order capacity. A missing subscription preserves the free storefront and standard commerce; Thread is an offer, not a paid entitlement. New custom orders require an active, unexpired paid subscription, an approved brand, an active owner and no intake block. Existing work continues under capacity and safety controls when new intake pauses.

| Tier | Monthly NGN | Active | In Delivery | Up Next | Paid jumps |
|---|---:|---:|---:|---:|---|
| Thread | 10,000 | 2 | 2 | 1 | No |
| Aso-oke | 15,000 | 3 | 4 | 1 | No |
| Aru | 30,000 | 4 | 5 | 1 | Brand opt-in |
| Igwe | 50,000 | 6 | 5 | 1 | Brand opt-in |

These are opening catalog values. Persisted catalog settings, agreement price snapshots, capacity campaigns and admin overrides remain authoritative under their existing rules. Nullable capacity values retain their current semantics. Changing a cap does not cancel existing paid work.

Initial activation and upgrades require verified payment and recurring-payment consent. A failed switch preserves the previous valid entitlement. Downgrades apply at renewal. Cancellation retains access until the paid period ends. Failed-renewal recovery and settlement repair remain current operational behavior.

Owners without a paid plan are offered Thread. Notices advance Thread → Aso-oke → Aru → Igwe, share one server-enforced 24-hour limit across web/native, and are suppressed for current Igwe subscriptions. Subscription and billing data remain private. Store Upgrade visibility uses the backend's available-higher-tier result.

## Payment admission invariants

Dedicated custom-order verification and unified checkout both call the canonical queue admission method inside their payment finalization transaction. Queue placement, policy version and held-fund allocation must succeed before a receipt or checkout completion commits. Failed admission rolls the transaction back and preserves provider-capture reconciliation. Pending/unpaid orders legitimately have no lane; they are not historical paid orders and must not be assigned a production stage by default.

The pre-policy paid-dispute lane reconciliation endpoint, presenter flag and admin panel are retired. Queue promotion no longer performs an extra count for those historical records. Captured-intent recovery remains: after provider success, a callback retry can still create the new order and admit it atomically. This is current recovery rather than grandfathering.

## Cutover requirements

The retired grandfather tier and brand eligibility flag are removed through an appended migration. The migration rejects references to the retired tier instead of silently converting a financial agreement. On 24 October 2026, the owner brought the authorized SIT/local reset and reference seeding forward as this cutover's prerequisite. Only the verified localhost/wiez_sit and localhost/threadly test databases are in scope. Each needs a backup with an actual restore check, stopped writers, reference/admin seeding and live verification. Do not use this policy to reset another environment or infer that a reset already happened.

Current legal documents use version `2026.10.23-v1.6`. Historical consent and billing records keep their original versions; new consent uses the current document definitions. Legal Markdown and generated web/native copies must remain synchronized.

## Regression coverage

### Customer qualification and entitlement expiry

Customers are authenticated shoppers with successfully paid standard or custom orders from the brand. Count each order once, regardless of its number of lines. Exclude cancelled and fully refunded orders; partial refunds retain the paid purchase. Guest orders without a shopper identity cannot be assigned to a customer. Inactive accounts retain masked purchase history.

Free brands see every qualifying shopper (one or more purchases). Paid brands may configure an integer threshold from 1 through 1,000, initially 3. Only the owner may change it. Expiry restores the effective threshold to 1 without deleting the saved paid threshold. Paid access uses the agreement's recorded price and exact paid-period end, not a later catalog price edit.

Commerce-access responses include serverNow and entitlementExpiresAt. Web and native schedule one expiry refresh from these values, make expired controls read-only immediately, and invalidate the scoped customer list. This avoids continuous polling and does not trust the device's calendar at receipt. The API remains authoritative when saving settings. An unavailable refresh cannot grant expired access.

Evaluate entitlement time after the database reads complete, so a slow read crossing expiry cannot return paid access. The staff-readable customer-list response contains only effectiveMinimumOrders in its settings metadata. Subscription tier, upgrade eligibility and paid-period timestamps stay on the owner-only endpoint. Customer settings navigation and cached entitlement presentation are owner-only, while authorized staff retain customer-list access.

### Local item-1 verification, 23 October 2026

- All 143 migrations and two reference/admin seed runs passed in an automatically removed disposable database. Four tier definitions, customer default 3, no seeded financial agreements, and preservation of an administrator's catalog price edit on reseeding were asserted.
- Six contraction/rollback scenarios passed. The real customer aggregation SQL passed paid, cancelled, full/partial refund, guest, privacy, search, pagination and brand-isolation cases.
- The actual queue integration suite passed six PostgreSQL scenarios with zero skips, including exact entitlement expiry with saved criteria, a write refused after expiry despite a successful preflight, concurrent shared notices, admission and sibling cancellation, partial-refund reservation, and production dispute compensation. Disposable database cleanup passed.
- Subscription/queue focused runs passed 67 and 53 tests; the subsequent commerce/customer run passed 12 tests. Web expiry utilities/hooks passed 8 tests; native expiry contract/parity passed. All three applications passed TypeScript checks.

Reproduce with scripts/verify-fresh-schema.cjs --seed, scripts/verify-subscription-tier-contraction.cjs, scripts/verify-customers-db.cjs and scripts/verify-subscription-queue-postgres.cjs. Evidence is in ../storage/evidence/fresh-schema.json, ../storage/evidence/subscription-tier-contraction.json and ../performance-reviews/subscription-queue-postgres-2026-10-23.json.

Item 1 is locally verified. Actual SIT/local reset and live cutover are now authorized before item 2 and remain pending until recorded in the release evidence. No live schema, payment-provider behavior, device rendering or running deployment is certified by these isolated checks.

Verify unsubscribed storefront access, blocked unpaid custom intake, exact paid-period expiry, first activation, failed switch, recovery, cancellation, owner/account safety, admin cap overrides, next-tier notices, highest-tier Upgrade suppression, both capture entrypoints and repeat finalization. Database reset, provider callbacks, device rendering and deployment are separate release checks; focused tests do not establish unlimited capacity or universal absence of defects.

Customer-setting writes lock the brand, then evaluate current paid agreement, owner access and database wall-clock expiry in the write statement. A successful earlier access read cannot authorize a write after expiry. This boundary also passed an actual PostgreSQL test.

### Release dependency checks, 24 October 2026

The first GitHub release validation was blocked by newly published parser advisories. Body-parser now resolves to 2.4.0, Multer to 2.5.0 through an explicit dependency override, and fast-uri to 3.1.9 in the lockfile. These retain the existing major versions. Upstream advisories: [body-parser](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828), [Multer](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m), [fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-w74x-v6f9-j3xg).

Three actual HTTP compatibility tests pass: ordinary/compressed JSON retains exact webhook bytes; invalid compressed trailing bytes cannot terminate subsequent requests; asynchronous multipart filtering and the exact field-size boundary work. The 37 upload/privacy mapper tests also pass. The high-severity production dependency gate passes; 12 moderate dependency findings remain in the compiler archive/file-type and Swagger YAML chains. This is not a claim of zero dependency findings.
