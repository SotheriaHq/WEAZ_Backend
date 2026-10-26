# Extension decisions and expiry

Update, 26 October: manual request creation, shopper acceptance/counter/rejection and brand counter resolution now enqueue durable notices in the same transaction as the request, dates, dispute and history. Rejection also commits its required admin-attention flag and active-admin notice records atomically, using a fresh bounded admin lookup. Shopper real-time invalidation runs after commit. The shopper's rejection confirmation is system-authored so the shared self-notification rule does not discard it.

Six actual constraint-failure/retry cases verify no leaked real-time update or partial state, budget, dispute or notice. The issue fixture passes33PostgreSQL cases with cleanup;58focused service/cron/admin-helper tests and types pass. A separate66-case PostgreSQL/Redis run exercises the real notification service's system-confirmation behavior. No deployed/device or universal race-free claim is made.

Creation, buyer response, brand counter response, expiry and stage-based voiding
serialize on the custom order row. Participant scope remains server-side. Each
decision reads current request state and allowance after the lock, so another
approval cannot consume the same allowance twice. Buyer responses respect the
recorded deadline. The existing null-deadline schema remains until the broader
canonical-flow/schema contraction; new requests always receive a deadline.

Production requests apply to ACCEPTED/IN_PRODUCTION. Delivery requests also apply
to READY_FOR_DISPATCH/IN_TRANSIT. Creation and voiding share the same target policy.
Completed production cannot void an otherwise eligible delivery request.

Only a winning expiry claim records intervention/history and its buyer, owner and
admin outbox notices. These writes share one database transaction. A losing claim
does nothing; an outbox failure rolls back expiry so the next sweep can recover.
Manual decision notification enqueue after commit remains a separate durability
finding in the wider concurrency audit; this document does not certify that gap.

25October2026:45service/cron tests and full backend types/helper lint pass. The
actual PostgreSQL fixture has27cases with successful cleanup, including eight new
extension cases:26competing creations,26buyer approvals,26counter approvals, a
budget committed during a lock wait, approval-versus-expiry, expiry/replay, actual
outbox CHECK-failure rollback/recovery and target-specific stage voiding. Shared
backend behavior covers desktop, tablet, browser-mobile and native clients. No
physical-device or provider delivery is claimed.

The installed stack uses Prisma7.10.1 and BullMQ5.76.4. Current Prisma website
documentation redirects to ORM8 APIs; those APIs were not copied into this code.

References:

- [PostgreSQL row locks and deadlock ordering](https://www.postgresql.org/docs/current/explicit-locking.html)
- [READ COMMITTED statement visibility](https://www.postgresql.org/docs/current/transaction-iso.html)
- [BullMQ idempotent retry design](https://docs.bullmq.io/patterns/idempotent-jobs)

All wider financial, tag/index, conversation, delivery-lease and product/refund
concurrency findings remain separate release gates.
