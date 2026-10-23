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

The retired grandfather tier and brand eligibility flag are removed through an appended migration. The migration rejects references to the retired tier instead of silently converting a financial agreement. The separately authorized SIT/local reset and reference seeding occur only after R2 readiness. Do not use the migration or this policy to reset another environment or infer that a reset already happened.

Current legal documents use version `2026.10.23-v1.6`. Historical consent and billing records keep their original versions; new consent uses the current document definitions. Legal Markdown and generated web/native copies must remain synchronized.

## Regression coverage

Verify unsubscribed storefront access, blocked unpaid custom intake, exact paid-period expiry, first activation, failed switch, recovery, cancellation, owner/account safety, admin cap overrides, next-tier notices, highest-tier Upgrade suppression, both capture entrypoints and repeat finalization. Database reset, provider callbacks, device rendering and deployment are separate release checks; focused tests do not establish unlimited capacity or universal absence of defects.
