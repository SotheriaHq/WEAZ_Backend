# Current payment row and reconciliation queries

Payment transitions acquire the current PaymentAttempt and its row lock in one
SELECT FOR UPDATE. A second Prisma lookup after the lock is unnecessary. The
result retains native Decimal, date and JSON fields; buyer/system-source,
terminal-state, settlement, order and event guards remain unchanged.

The helper is also used by unified finalization and both custom-order verification
locks. Those complete paths require their own regression checks; sharing a tested
lock does not certify their remaining financial or notification behavior.

Actual PostgreSQL checks26 stale expirations with one shared candidate scan plus
26 locked current-row reads and no separate per-attempt reloads. Order, settlement
and event transitions occur once. Competing terminal replays preserve the original
terminal state and a wrong buyer is refused. A separate competing-writer check
confirms that a waiting lock/read returns committed current data. Missing references
and a native12345678.91 Decimal are covered.

Stored webhook replay already batches receipt and attempt identities. Each receipt
still checks current payment lifecycle and its own processing state. The real
reprocessor handles26 terminal receipts, then zero on repeat, without another
lifecycle transition. This is required command-state work rather than related
display/media hydration. Incoming signature transport, nonterminal external
provider confirmation and distributed claim/fencing races remain separate gates.

The same disposable harness includes the subscription-only local Postman HTTP
checks. Standard/custom provider success is not established by expiration or
terminal receipt tests.41 focused payment/custom-payment unit tests pass, including
existing signature and amount guards; those unit transport mocks are not live
provider or device-delivery evidence. Telegram outcome recording remains unchanged.

## Custom reconciliation context

Reference reconciliation reuses its authorized initial capture in a private verifier. A separate SELECT FOR UPDATE still returns current state before commit. Order/brand-owner/buyer first and last name come from one native scalar JOIN, including after a paid-repair brand lock. Canonical profile data remains UserProfile; no file/profile-media hydration.

Real PostgreSQL21cases pass with cleanup, including26custom captures through actual payment verification HTTP against local Postman:26contextJOINs and27Prisma capture reads(one scan+26references), zero eager profile/media/brand reads,26held admissions/receipts/conversation links and correct outbox recipients. Replay adds no transport or money. Pending/failed/wrong amount/503, buyer/gateway isolation, missing order and optional canonical profile verified.9custompayment tests, full types/lint pass. The optional trusted PAYMENT_PAYSTACK_BASE_URL injection changes only verification; default official origin remains unchanged. No user-supplied URL or production setting was introduced. Fresh intent creation, live provider acceptance, messaging concurrency and durable-delivery races remain separate gates.

## Standard success reconciliation

Paid-order recipient facts now use one native Order/Brand JOIN scoped to capture reference and buyer, preserving native Decimal and deterministic order. Each capture still runs its own current locked transition, financial journal/receipt and notification guards. Actual PostgreSQL35cases pass with cleanup, including26successful stale captures verified through local provider HTTP,26escrow holds/receipts/conversation messages and52correct buyer-owner notices. Replay adds no transport/journal/notice; missing/wrong buyer and native money verified.41payment tests/types/helperlint pass. The two independent notice commands per capture retain fresh actor hydration(52Brand reads for26captures); those are measured and not claimed eliminated. Live provider/device delivery and broader failures/races remain separate.

## Unified finalization current state

A native SELECT FOR UPDATE returns current session facts, followed by one dependent line read; it replaces lock-only plus reload. Selected committed standard-order identities use one native reference/ID-scoped owner JOIN. Custom intent/configuration/version reads remain shared; queue admissions keep fresh sequential capacity and financial guards.

Actual PostgreSQL25cases pass with cleanup, including26standard lines across26brands,26fresh custom lines, held funds/receipts/reservations/cart quantity conservation, replay, missing-intent rollback, wrong buyer and real session-lock wait freshness. A fresh checkout exposed advisory-lock void deserialization in the cart helper; executeRaw now acquires the same buyer lock, and a real competing paid consumer preserves quantities committed by its predecessor.41payment+6bag tests, full backend types/helperlint pass. Provider acceptance and wider concurrency/currency/compatibility gates remain separate.
