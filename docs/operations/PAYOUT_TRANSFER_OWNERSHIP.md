# Payout transfer ownership and recovery

## Authorization and sending

Each transfer authorization locks Brand, then Payout, reads the current administrative owner and rechecks the reserved source total, account safety and current NGN money position. Payout reservations already reduce that position; a negative result blocks both initial transfer and OTP finalization. A debt committed before authorization therefore cannot be missed by a payout waiting on the brand lock.

The transaction saves the original provider reference, recipient, processing state, unique operation owner and administrative audit before any HTTP request. No connection or database lock is held while Paystack responds. HTTP has a 15-second budget and redirects are refused. OTP is transmitted without being saved to audit or event records.

An operation owner is valid for ten minutes according to the database clock. A competing send or lookup cannot replace a live owner. Responses are applied only after taking the source locks and checking the current owner again. A webhook may complete first; its committed result invalidates the pending HTTP owner. Late replies are recorded as evidence and cannot settle another owner's operation.

## Provider evidence

Amount in minor units, currency, reference, transfer code and available recipient identity must agree with the reserved payout. Contradictory terminal webhook status is refused. Delayed pending/failed replies cannot undo a paid payout. A reversal stays in reconciliation; a subsequent success cannot disburse the payout twice. Ledger and statement issuance occur in the same result transaction and remain idempotent.

Manual status edits cannot free a reservation while its provider transfer is outstanding. Administrative claim/release decisions also read the locked current owner.

## Ambiguous outcomes

A timeout, lost response or contradictory response does not prove that no transfer was created. Keep the payout reserved and verify its original transfer. Verification uses its code when available or `GET /transfer/verify/:reference` otherwise. It never creates a new identity. A provider-confirmed failure may be retried explicitly with the same reference and recipient.

If a process died with an active owner, wait for the ten-minute ownership window before verifying. A provider 404 or outage is not proof that a transfer can be sent again: Paystack documents a request-validation interval before a transfer becomes retrievable. The reservation remains until reliable provider evidence or operational reconciliation resolves it. Do not edit database fields to force a retry or interpret a cancellation as bank credit.

Paystack references: [single transfers](https://paystack.com/docs/transfers/single-transfers/), [transfer lifecycle and double-credit prevention](https://paystack.com/docs/transfers/how-transfers-work/), [transfer API](https://paystack.com/docs/api/transfer/).

## Migration and verification

Stop old transfer writers and webhook workers before applying `20261028140000_payout_transfer_ownership`; old processes do not enforce ownership. The migration adds a nullable UUID/time pair with a database pair constraint. It does not invent ownership for existing provider requests. Deploy all current transfer writers together before enabling execution. The default execution flag remains disabled.

The actual PostgreSQL/loopback-HTTP fixture checks competing initiation, free database locks during HTTP, competing OTP requests, webhook versus delayed reply, lost/mismatched responses, current debt after a real lock wait, OTP debt checks, terminal event ordering, stable-reference failure retry and opposing administrative claims. The integrated financial fixture passes 55 scenarios on PostgreSQL 17 and isolated PostgreSQL 15 locally; 23 focused payout/order unit tests and backend types pass. No live-provider money or device behavior is certified by the simulator. Remote CI, migration deployment and explicit gateway acceptance remain release gates.

Run `node scripts/verify-standard-refund-integrity.cjs` against a loopback PostgreSQL source. The script creates and removes its own database. `--payout-only` produces a separate focused report without overwriting the combined report.

## Currency integration and deployment drain

The current SIT currency policy is preserved during integration. Provider
refunds use the charged amount/currency, while standard-order settlement
reversals use the original NGN snapshot. The current integration fixture adds
USD standard/custom provider checks and a lost refund behind 150 unrelated
records when the optional transaction filter is ignored. Pagination is bounded
to ten pages with a creation-time lower bound; any incomplete lookup remains
unknown and cannot authorize resubmission.

The deployment now stops the old API and worker before installing dependencies
or migrating. Its read-only migration preflight detects unapplied/failed schema
changes. If a deployment fails before schema changes are attempted, the verified
release is restored. Once new migrations have been attempted, old binaries are
not automatically restarted against an unverified schema: writers stay stopped
for forward repair. The four-case shell fixture verifies successful ordering,
failed migration, failed install and failed build using a temporary application
and command stubs. No real deployment is performed by that fixture.
