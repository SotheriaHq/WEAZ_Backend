# Payout-account synchronization

Status: local implementation and verification; not released. Complete the adaptive-access release checks before deploying this change.

## V1 ownership

One Nigerian payout bank account can belong to only one WIEZ brand. Shared accounts between brands are deferred to V2. WIEZ enforces the restriction with an indexed HMAC identity and a unique database reservation, including simultaneous requests. The identity includes country, currency, bank code and the full account number; last-four digits are never an ownership key. Neither the account number nor its identity secret appears in error messages or logs.

Paystack keeps its normal duplicate-recipient behavior. A returned recipient is checked against WIEZ ownership before it is saved. An unsuccessful request must never deactivate a recipient merely because a create request returned it: it may already exist.

## Admission and execution

The owner approves the exact request and server-resolved account version. A short transaction checks current authority and ownership, consumes the one-use approval, reserves the bank, and saves the encrypted provider command. Provider requests use that saved command and run outside database transactions, with a 20-second HTTP timeout. Each provider checkpoint and final account change must hold the current sync lease.

Subaccount creation has no assumed idempotency guarantee. A lost create response is reconciled by the saved attempt's metadata and verified account/currency/bank details. Listing is bounded and restricted by creation time. A missing, duplicate or unverified result keeps the update pending; it never triggers a blind second create. Recipient creation follows Paystack's documented duplicate-account behavior, with the returned details verified again.

The current account remains available while a replacement is pending. Logout or cancellation ends the caller's authority, but does not erase an already-admitted command or prevent recording its outcome. The caller must still be authorized before receiving the resulting account response. A replaced/expired lease cannot apply stale state or issue the next command.

## Preparing a release

1. Configure `STORE_PAYOUT_IDENTITY_SECRET` as a stable, random 32-byte key encoded in standard Base64. Keep it separate from `STORE_PAYMENT_ACCOUNT_SECRET` and keep the same value on all instances in that environment. Generate and save it securely; do not paste it in chat or commit environment files. Encryption keys may rotate using their explicit previous-key configuration. The identity key must not be changed as ordinary encryption-key rotation.
2. Drain payout-account mutations and stop the previous backend/worker version before the coordinated cutover. Do not run the previous account writer alongside this implementation: it does not participate in the new admission/reservation protocol. No database reset is required.
3. Apply the additive migrations and generate the matching Prisma client. Bank updates start closed by default. Existing account reads and payout processing are not evidence that preparation is complete.
4. Run `npm run payouts:prepare-bank-claims` with the target backend's environment. This command checks existing encrypted accounts in bounded batches, rejects duplicate ownership, and opens the indexed readiness gate only after preparation finishes. It is resumable after a failure. It changes ownership indexes, not bank details or balances, and makes no provider calls. Unfinished sync attempts must be reconciled before preparation can run.
5. Check the reported counts and key identifier, run the real database/Redis verification and focused regression suites, then enable the coordinated client/backend release. If preparation fails, bank updates remain closed. Restore the established identity key if it was changed accidentally; do not delete claims to force preparation through.

## Recovery

An interrupted request receives `PAYOUT_ACCOUNT_SYNC_PENDING`. Retry the same update with fresh action verification. A different update cannot replace an unresolved command. Support can inspect the attempt ID, stage, failure code and lease without exposing its ciphertext or bank details. Inspect the provider record by the attempt's metadata; do not create another subaccount merely because the first request timed out. A provider ownership conflict needs investigation before proceeding.

Old recipients are retired by a bounded background task only after the replacement is committed, no current account uses the old code, no account update for that brand remains unresolved, and no pending/uncertain payout still depends on it. The reservation stays in place during retirement. Lookup of an already-inactive/deleted recipient permits recovery from a lost delete response. The obsolete claim is released only after verified retirement. Pending recipients are excluded before pagination so they cannot starve eligible work.

Before live acceptance, verify the configured Paystack environment's create, update, lost-response reconciliation and deactivate/reuse contracts with test data. Local synthetic-provider tests do not establish those live-provider behaviors. Keep all existing money-movement and original-reference reconciliation checks.

## Verification

`npm run test:adaptive-access-postgres` creates and removes its own loopback-only disposable database; PostgreSQL and Redis must be available. It never resets application databases. Provider responses in bank/payout recovery cases are synthetic. CI runs this command alongside the focused access, Store and payout suites.

[Paystack recipient API](https://paystack.com/docs/api/transfer-recipient/) documents duplicate-recipient reuse. [Paystack subaccount API](https://paystack.com/docs/api/subaccount/) documents stringified metadata and list filters; no undocumented subaccount-create idempotency is assumed.
