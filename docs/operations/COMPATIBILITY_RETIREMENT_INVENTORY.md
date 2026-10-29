# Compatibility Retirement Inventory (item 7)

Branch `feat/item7-compat-retirement`, based on SIT `c9235b0`. Audit date 2026-10-28/29.

Read this as: what each old-data path supported, whether that data exists, what
can still produce it, what replaces it, and whether it was removed or kept.

## Evidence

Read-only counts (`BEGIN READ ONLY … ROLLBACK`). SIT is `wiez_sit`, the database
the API and worker load from `~/WEAZ_Backend/.env`. Local is `threadly` on localhost.

| Count | SIT (2026-10-29) | Local (2026-10-28) |
|---|---|---|
| Users | 2 (seeded admin + one sign-up 2026-10-28) | not counted |
| Brands | 1 | 0 |
| Products | 0 | 0 |
| Orders (any status) | 0 | 0 paid |
| Paid orders without an escrow hold | 0 | 0 |
| Payment attempts (any subject) | 0 | 0 |
| Saved payment methods | 0 | 0 |
| Saved methods migrated from attempts | 0 | 0 |
| Products with `sizingMode = RTW_PLUS_CUSTOM` | 0 | 0 |
| Users with stored notification settings | 0 | 0 |

SIT payment flags at audit time: `PAYMENT_CANONICAL_SAVED_METHODS_ENABLED=false`,
`…_CANARY_PERCENT=0`, `…_BACKFILL_ENABLED=true`, `PAYMENT_LEGACY_*=false`.

## Removed

| # | Path (before) | Old state supported | Exists? | Producers | Replacement | Tests | Commit |
|---|---|---|---|---|---|---|---|
| R1 | `payout.service.ts` `getLegacyFallbackBalance`, `buildLegacyStandardIncomeItems`, legacy orders in `listIncomingTransactions` | Paid standard orders with no escrow hold counted as withdrawable, using a commission-rate recalculation | No (0 paid orders without a hold) | None: `repairStandardOrdersMissingHolds` (`payout.service.ts:1212`) turns such an order into a hold before balances are read | Ledger position (`loadBrandPosition`) is the only withdrawable balance | `payout.service.spec.ts` "takes the withdrawable balance from the ledger position alone"; PG refund/payout integrity 16 cases incl. availability capped by position | `a7b2122` |
| R3 | `POST /payment/webhook/paystack`, `/payment/webhook/flutterwave`, `/admin/payouts/webhook/paystack` forwarding + `PAYMENT_LEGACY_*` flags | Provider dashboards still pointing at old URLs | Flags were `false` on SIT, so forwarding was already off | None in code | `POST /webhooks/paystack`, `POST /webhooks/flutterwave`. Old URLs answer 410 with the new URL and enqueue nothing | `payment.controller.spec.ts`, `admin-payouts-webhook.controller.spec.ts` (410 even with the old flags set) | `b76a918` |
| R4 | `.env.example` `PAYMENT_LEGACY_*` and `PAYMENT_CANONICAL_SAVED_METHODS_*` lines | Documented flags for removed paths | n/a | n/a | Comments naming the canonical webhook URLs and the saved-method secret | n/a | `b76a918`, `713ede7` |
| R2 | `payment.service.ts` `listSavedPaymentCardsFromAttemptHistory`, `collectLegacySavedPaystackCardsWithAuthorization`, `backfillSavedPaymentMethodsFromAttempts`, attempt-id fallback in `resolveSavedPaystackAuthorization`, `paystack-<attemptId>` ids, `isCanonicalSavedMethodsEnabledForUser` + canary, `isSavedPaymentMethodBackfillEnabled` | Cards inferred on read from PAID attempts' JSON snapshots; card ids that were attempt ids | No (0 attempts, 0 saved methods) | The PAID transition wrote the reusable authorization code into `PaymentAttempt.responseSnapshot` in plaintext; that was the only source | `rememberVerifiedCheckoutCard` saves the card into `SavedPaymentMethod` (encrypted) after the PAID transition commits, from `applyAttemptStatus` (verify, webhook, reconcile) and both direct custom-order verify paths. Snapshots keep a display-only summary (`providerVerificationCard`, `providerWebhookCard`) | `subscription-payment-cards.spec.ts` (save once, encrypted; nothing saved on opt-out / non-card / non-reusable / no buyer; never fails the payment; code absent from snapshot; canonical-only list and charge; old attempt id refused); `custom-orders-payments.service.spec.ts` (saved once after PAID, never for terminal) | `713ede7` |

R2 also closes a data exposure: the admin finance payment detail
(`admin/finance/admin-finance.service.ts:1008`) returns `responseSnapshot` as stored,
which included the reusable card authorization. No rows exist on SIT or local, so
there is nothing to scrub.

`getClientCheckoutPolicy().savedMethods.canonicalEnabled` still returns `true`,
because shipped web clients read the field (`fthreadly/src/api/PaymentApi.ts:58`).

## Kept, with reasons

### Not old-data compatibility (live behaviour)

| Path | Why it stays |
|---|---|
| `finance/settlement-backfill.service.ts:113` | Dry-run reconciliation audit used by CI and ledger concurrency verification, not a migration backfill |
| `payout.service.ts:1212` `repairStandardOrdersMissingHolds` | Race/repair safeguard for a paid order whose hold write did not land |
| Custom-order allocation income in `listIncomingTransactions` (`payout.service.ts`) | Live producers mark allocations PAYOUT_ELIGIBLE without a ledger post: `custom-order-admin.service`, `custom-orders.service`, `admin-payouts.service`, `custom-order-queue.service` |
| Direct `CUSTOM_ORDER` payment attempts (`custom-orders-payments.service.ts`) | Live checkout path |
| `standard-order-message-query.ts:3,22` `LEGACY` placement-thread origin | Threads with `pairKey: null` are still created (`messaging.service.ts:1371`, `collections.service`, `custom-order-thread-bootstrap`) |
| `designs/adapters/legacy-collection-design.adapter.ts:15`, `content-integrity` `legacyCollectionId`, `common/domain/catalog-target.ts` | The `/designs` and `/collections` route families are active; `legacyCollectionId` is the live design identity for reviews, saved items and catalog targets |
| `collections/dto/create-collection.dto.ts:186,209` `collectionMetadata` | Installed native builds may still send it |
| `store/store-policy-constraints.ts:15,24` lead/processing time maps | Input normalisers for values clients still send |
| `admin/market-governance` `DEPRECATED` status | Ranking-formula lifecycle and rollback, not compatibility |
| `common/config/production-env.validation.ts:1` | Refuses a known unsafe default secret in production |
| `email/email.service.ts:118` `legacy.direct` | Default scenario label for callers that pass none |
| `brands/brand-access.service.ts:213` owner membership fallback | `Brand.ownerId` is still canonical ownership |
| `brands/brands.service.ts:239,267` banner fallback | Brands without a banner asset row still render |

### R2 integration update — 29 October

SIT integration now includes private R2-only provider resolution, mandatory signed PUT uploads and no AWS/IAM/public-bucket/CDN fallback. The protocol SDK remains necessary for R2. Retired public URL environment names are rejected by configuration validation, rather than read as a compatibility path. Real R2 application verification passed nine scenarios and cleaned all 32 temporary objects. Server activation is tracked separately from this source-level evidence.

### Blocked or out of scope

| Path | Reason |
|---|---|
| Current WebP delivery and image batch reprocessing (`queue/image-processing.processor.ts`) | Current media processing capabilities; AWS provider/credential/public-URL and POST fallbacks have been removed. Retired configuration names are denial guards only. |
| `prisma/schema.prisma:542` `RTW_PLUS_CUSTOM` enum value | 0 rows, but removal needs a forward migration that drops an enum value; low value, deferred |
| `categories/categories.service.ts:991,1058,1150` legacy taxonomy deactivation | Idempotent taxonomy reconciler in the design-taxonomy area, which another workstream owns |
| `notifications/notifications.service.ts:547` old preference keys (`engagement`, `security.login`, `social.comments`, `orders.updates`) | 0 stored settings on SIT and local, but `security.login` is still a current default key and `custom-orders.service.ts:3295` writes the same JSON directly. Needs a settings-schema owner before removal |
| Web/mobile route redirects and catalog-target helpers | Routes still used by installed native builds |

## Owner actions

1. Delete these lines from the SIT `.env` (they now do nothing):
   `PAYMENT_CANONICAL_SAVED_METHODS_ENABLED`, `PAYMENT_CANONICAL_SAVED_METHODS_CANARY_PERCENT`,
   `PAYMENT_CANONICAL_SAVED_METHODS_BACKFILL_ENABLED`, `PAYMENT_LEGACY_*`.
2. Confirm `PAYMENT_SAVED_METHODS_SECRET` is set on SIT. Without it, cards are not saved
   (payments still succeed; a warning is logged).
3. Confirm the Paystack dashboard webhook points at `/webhooks/paystack` on the SIT API
   host. The old URLs now return 410.
