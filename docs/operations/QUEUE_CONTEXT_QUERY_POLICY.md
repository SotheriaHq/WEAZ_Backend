# Queue capacity and settlement context

Each capacity check now reads brand controls, owner safety, the latest relevant
agreement, tier limits and campaign adjustment through one indexed JOIN. It is
still a fresh check at the protected mutation; brand locks and separate command
transactions remain. No cross-transaction capacity cache was added.

The projection preserves the Thread fallback without granting unpaid intake,
the exact paid-period boundary, zero and expired overrides, unlimited null limits,
manual/automatic campaign rules, owner/verification safety and missing-brand errors.
An expired agreement blocks new intake while safety checks allow already-paid
work to progress. Public summary fields and shopper plan privacy are unchanged.

Custom settlement reads one scalar current order/brand/owner projection after
the existing brand lock. Lane, activation/cancellation markers, captured summary,
native Decimal jump amount and owner safety remain authoritative. Allocation
statuses and separate journal receipts/balances are still checked before writes.
The nullable/missing-order behavior was not changed in this query pass.

Real PostgreSQL checks cover26 waiting captures with no early release, two Active
and one Up Next, repeated drain without over-admission, suspended-owner safety,
timeout completion with one final posting and buyer/owner notice handoff, paid-work
progression after expiry, and the real cursor sweep. A capacity guard uses one
SELECT;26 settlement guards use26 scalar JOINs with no eager relation hydration.

This is query/transaction regression evidence, not a complete race, currency,
provider or device-delivery certification. Cancellation, jump settlement and other
remaining command paths retain separate audit entries. No new client layout or
permission flow was changed; desktop, tablet, mobile web and native use the shared
backend records and API behavior.

## Cancellation and priority fees

Bulk cancellation and expiry use the same cancellation command as the public
endpoint, without building and discarding its queue response. The public endpoint
still returns that response. After capture and brand locks, current order state
and brand recipient are read in one scalar JOIN. Participant authorization,
revision, current waiting lane, expiry and shared capture/refund budget checks
remain separate current guards. Refund settlement uses the original payment
exchange-rate snapshot and cumulative rounding; it is never estimated from a
new exchange rate. Bulk results retain independent per-order failures.

Priority-fee allocation creation uses the existing unique financial-event key
with INSERT ON CONFLICT DO NOTHING, followed by the existing idempotent ledger
posting. It performs no existence read and never resets a paid allocation.

Actual PostgreSQL13 scenarios now include26 priority-fee commands and replay,
26 bulk cancellations plus an in-delivery refusal,26 expiry cancellations,
authorization/missing-record checks, correct recipient isolation and public
response parity. No provider transport is invoked by these reservation paths.
The wider race, provider completion and currency audits remain separate.

## Paid admission metadata

Admission reads only brandId to route its initial lock, then reloads the current
order and retains the existing position, finance, buyer, entitlement and drain
guards. The current capacity JOIN also supplies the owner for placement and expiry
notices and any eligibility-cancellation notice. That owner is reused only within
the protected command; no global or cross-command eligibility cache was added.

Actual26 admissions inside their shared parent-capture transaction use no
standalone Brand metadata SELECTs. With zero Active capacity, all26 full captures
remain HELD;52placement notices and156expiry reminders are retained. Replay adds
neither money nor reminders. FIFO and public permission/API behavior remain covered
by28 queue tests. This is not full upstream checkout/provider certification.
