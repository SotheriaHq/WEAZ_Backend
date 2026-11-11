# Held subscription prices and checkout recovery

Status: implemented locally, release verification in progress. This document does not authorize a deployment or claim live-provider acceptance.

## Customer behavior

Preview saves the exact offer for five minutes, measured by the database clock. The offer includes the brand, actor, requested tier, current agreement version, immediate NGN amount, target recurring NGN price and billing dates. Routine bookkeeping timestamps do not change that agreement version. A price change in the tier catalogue does not change an unexpired saved offer. A material agreement change does invalidate it. Expiry requires displaying a fresh price, renewed consent and a new action approval.

The quote is consumed in the same transaction as exact-action approval and the invoice/payment instruction. A retry cannot turn one offer into multiple invoices. An already admitted payment retains its approved amount after the preview expires. The web/native local timer is conservative and does not trust a manually changed device clock; the backend remains the final authority.

For scheduled downgrades, the owner-approved recurring price is saved with the scheduled plan. Renewal uses that snapshot even if the tier catalogue changes before the effective date. Cancellation and a successfully replaced agreement clear both the scheduled plan and price together. Missing approved pricing is an error; it never falls back to the catalogue. Both clients display the approved next-renewal price.

## Payment protocol

`BrandSubscriptionCheckoutCommand` is an invoice-specific instruction, encrypted using the payment storage key with brand, invoice and command identity authenticated into the ciphertext. Its contents include the exact amount/currency/reference, payer identity, return URL and any authorized saved-card credential version. The partial unique index permits one unresolved instruction per invoice. The brand-serialized admission also blocks a second plan payment while the brand has any unresolved checkout. An existing automatic billing worker must finish/reconcile its invoice before a human checkout can reserve it. No provider request is sent from the approval transaction.

- `READY`: committed intent with no dispatch marker; a stopped worker can recover it.
- `DISPATCHED`: the no-replay marker committed before provider HTTP. A crash at this boundary is uncertain even if HTTP might not have started.
- `WAITING`: awaiting verification or customer checkout; keep the existing reference and URL.
- `SUCCEEDED`: verified capture recorded through the existing invoice/capture/entitlement transaction.
- `FAILED`: verified failure or a locally blocked instruction; no automatic replay of that command.
- `REVIEW`: uncertain submitted reference, corrupt instruction or mismatched provider facts. No new command for this invoice may be admitted until reconciled.

Workers claim a two-minute database-clock lease with a random token. Provider requests have a 15-second timeout. The worker rechecks its lease, immutable ciphertext, invoice/reference and terminal state before dispatch. Saved-card removal and the dispatch marker use the same payment-method account lock: removal before the marker blocks the charge; removal after it cannot cancel an in-flight provider instruction. Provider HTTP holds no database transaction open. Late results can only update the command/invoice while the same lease is still current. Verified captures remain independently recordable even if a response arrives after the caller signs out. A fresh caller/session/brand authority check protects the private HTTP result.

Every already submitted reference is verified before another debit is considered. Provider `NOT_FOUND` after the dispatch marker is uncertainty, not a guarantee that no charge occurred. Do not replay or generate a new reference to resolve it. A lost hosted-initialization response is also uncertain. Resolve the existing provider reference with billing support. Do not manually clear the dispatch marker or rewrite command ciphertext.

Zero-charge upgrades use the admitted command and the existing capture/entitlement transaction, with no Paystack request. Recovery is idempotent by invoice/reference.

## Recovery and operating checks

The existing one-minute billing job recovers at most ten due commands per invocation. Exclusive claims permit multiple workers. The ordinary renewal worker excludes invoices with unresolved checkout commands; it keeps its existing recorded-reference safeguards for automated renewals. The command table indexes state/due time and invoice/history. Keep used offers, commands and invoice links as payment audit evidence; expired unused previews are deleted in batches of at most 1,000.

Inspect command state, invoice state, provider reference, dispatch timestamp and next attempt. Do not log ciphertext, authorization codes, payer emails, checkout URLs/access codes or action proofs. A `REVIEW` record requires provider-reference reconciliation, not an automated reset. There is no new automatic refund or second-debit path here; existing duplicate/unapplied capture compensation remains responsible for real captured money.

## Coordinated release requirements

Apply the held-quote and durable-checkout migrations with the matching backend and both clients. Old clients do not supply `quoteId` and must not be silently admitted without one. Retain `PAYMENT_SAVED_METHODS_SECRET` securely; no new secret is required for this command format. Never rotate it by deleting access to existing encrypted payment instructions.

The scheduled-price migration also requires a coordinated cutover. It deliberately stops if any existing scheduled change has no recorded approved price. Before deployment, inspect existing scheduled changes and arrange fresh approval or explicit cancellation; do not populate the field with a guessed present-day catalogue price. The migration is transactional and enforces that scheduled plan and approved price are either both present or both absent. Stop older writers before admitting new scheduled changes under the new schema.

Run focused quote/card tests, the disposable PostgreSQL/Redis recovery scenarios, the wider financial/provider matrix, both client typechecks and native design audits. Verify actual MFA enrollment/approval, expiry during verification, hosted payment and saved-card settlement on supported clients against the intended provider environment before releasing. Synthetic loopback responses do not prove the live Paystack contract or mobile acceptance.
