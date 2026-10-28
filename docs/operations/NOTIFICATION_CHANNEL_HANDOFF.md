# Durable notification channel handoff

The inbox entry and its delivery instruction now commit in one transaction. A channel enqueue failure preserves the inbox and leaves a retryable instruction. Email and push outbox jobs, and acknowledgement of the instruction, commit together in a second transaction. External email/push transport is outside both transactions.

The instruction references the canonical notification through a foreign key to its mapped `_id`. It stores the rendered message, push payload, routing and creation-time settings needed for delivery. Batched email policy snapshots retain only email/consent/scenario/suppression fields; candidate notification histories are excluded. Final email suppression and active push-token checks remain in their delivery dispatchers.

Channel jobs use the existing notification UUID for idempotency (`notif:<id>` for email; the same UUID as the push outbox identity). A repeated inbox event can resume a pending instruction without duplicating completed channel jobs. Retiring a completed instruction does not recreate it on a later inbox replay.

## Claims, retries and resource bounds

- Claims use database UTC, `SKIP LOCKED`, a fresh UUID owner and a 60-second lease. The claim joins the canonical notification instead of reloading each notification separately.
- Immediate batch handoff claims at most ten rows at a time within each 25-event scope. Scheduled recovery runs every ten seconds, with at most 100 claimed instructions per sweep.
- Recovery of individually created events loads missing email policies once per claim group, using the existing recipient/preference/scenario JOIN and one shared suppression read. Stored batch snapshots retain their original policy. No second database connection is needed from inside a channel transaction.
- Each instruction keeps an independent transaction and result. A stale owner cannot enqueue channels, acknowledge a replacement or overwrite its failure state.
- Failed enqueueing uses exponential backoff and an eight-attempt ceiling. A crash on the final attempt becomes an explicit exhausted failure after lease expiry.
- Hourly retention removes bounded groups of at most 1,000 completed instructions older than 30 days and 1,000 exhausted instructions older than 90 days. Active/retryable instructions remain. An index on status/update time supports retention.

These bounds protect database resources; they are not a production throughput claim. Queue age, backlog and actual load tests must guide deployment sizing.

## Verification

### 26 October follow-up: semantic creation, login and manual admin delivery

The latest focused PostgreSQL run passes 33 cases with cleanup and zero external provider calls. It includes the original 12 channel cases, ten semantic-creation cases, six auth/admin cases and five product-creation transaction cases. All 156 current migrations, including the pending financial/integrity migrations, apply in that disposable database. This does not verify all financial behavior or apply anything to the application databases.

Semantic notifications without an explicit event identity now lock their recipient/type scope, then read current candidates in a separate READ COMMITTED statement. The database clock evaluates the window after a lock wait and timestamps a new event after that wait. The existing null-actor wildcard, newest-25 candidate bound and separate older explicit-target match remain. Distinct explicit event IDs and dedupeMs=0 retain their bypass contract. The incoming fingerprint includes the same merged target payload as the persisted notification.

Each independent semantic command needs one fresh bounded guard read and one scope lock; these are authoritative mutation checks rather than recipient/actor hydration. For 26 commands, actual PostgreSQL records 26 guard reads, 26 locks, four shared policy reads and zero per-recipient user hydration. The combined fixture reports these guard commands separately, preserving its shared-policy budgets. The new recipient/type/createdAt index supports the current candidate query.

Trusted-device recording now uses one conflict-safe upsert. Thirty-two competing first logins retain one device and classify only its inserting request as new. Returning logins preserve trust, first-seen time and revocation. Login/signup callers await database enqueueing; delivery remains asynchronous. Inbox-disabled login uses the explicit notification identity for email idempotency, honors producer suppression and waits for email enqueueing. LOGIN validation retains newDevice/highRisk/method so scenario preferences are evaluated on the actual login context. Existing best-effort failure behavior is retained: a database enqueue failure is not proof of delivery.

Manual admin sends keep their explicit in_app/email/both channel choices. Their log, audit, optional inbox and email outbox job now commit together, with a stable log-derived email key. An actual enqueue constraint proves rollback and successful retry. Subscription billing already writes its inbox/email receipt atomically; the remaining direct collection notification helper has no active callers. No push policy was inferred for these manual/billing paths.

The focused checks pass 139 distinct tests across the combined nine-suite and corrected targeted runs. The two older fixtures now include the explicit SLA refund trigger and a notification timestamp for window checks. The final 36-test notification suite and affected auth/admin/notification/inventory source lint pass. Full backend typechecking still has four old financial test-interface errors from the in-progress refund rewrite. Thus wider item3 and the overall release remain open.

The product-creation cases verify a whole-transaction slug retry, five cold competing writers, rollback of earlier product/membership changes, refusal to retry unrelated uniqueness errors and a three-attempt ceiling. They exposed a shared-trigger record-field error in the pending primary-membership migration; the corrected nested branch permits valid writes while still rejecting inconsistent primary pointers. A successful migration alone did not catch this runtime defect.

CI now provisions disposable Redis and opts into the existing real queue fixture, and includes the new PG scenarios. The configuration is not a claim that remote CI has run; no commit/push/build/deployment has occurred for this follow-up.

Implementation references: [PostgreSQL15 ON CONFLICT/RETURNING](https://www.postgresql.org/docs/15/sql-insert.html). Provider refund protocol review remains separate; [Paystack's refund API](https://paystack.com/docs/api/refund/) documents the list filter as a transaction ID, which must not be assumed interchangeable with a merchant reference.

### Earlier combined evidence

The combined PostgreSQL/Redis fixture passes 78 scenarios with cleanup. The focused fixture passes 12 channel scenarios with cleanup and zero external provider calls. These 12 scenarios are included in the combined run, rather than additional cases.

Coverage includes API interruption after inbox commit, 32 competing recovery sweeps, actual email/push/instruction constraint failures, stale owner and late failure fencing, final-attempt crash recovery, 32 cold inbox writers and replay after retention. All 96 focused tests across seven suites, backend type checking and source lint pass.

Recovery of 26 individually persisted events uses three joined policy reads and three suppression reads, with no per-event user/preference reads. Actual global opt-out, scenario opt-out and suppression each prevent their email without blocking push. A separate case preserves the existing creation-time batch snapshot without fallback reads. This verifies enqueue decisions; final suppression is also enforced by the delivery dispatcher.

The original batch read budgets remain: nine fanout reads with three separate mutation-claim commands, eight stock-reminder reads/four claim commands and eight bag-reminder reads/four claim commands. Mutation CTEs contain SELECT clauses, so the fixtures report their bounded claim budgets separately from consent/actor reads rather than hiding them in a higher read limit.

Run the focused fixture with `node scripts/verify-notification-channels.cjs`, or the combined fixture with `node scripts/verify-checkout-media-batching.cjs`. Both create and remove their own UUID-named loopback database. The combined fixture optionally verifies actual Redis with `VERIFY_LOCAL_REDIS_OUTBOX=true`. Fresh migration failures retain redacted private diagnostics.

## Rollout and inspection

Migration `20261026101500_notification_channel_outbox` is required before starting the new code. It has been verified only in disposable databases; application databases have not received it. Drain old producers/dispatchers before migration and restart. Existing inbox history is not converted into delivery instructions by guessing its original delivery intent.

Inspect operational state without reading notification content:

```sql
SELECT id, status, attempts, "availableAt", "createdAt", "lastError"
FROM "NotificationChannelOutbox"
WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')
ORDER BY "availableAt", "createdAt"
LIMIT 50;
```

Failures log the notification identity, attempt and a bounded error code. Exhausted instructions require operational investigation. This change verifies durable channel handoff, not actual device delivery, native permissions or a universal absence of races. Semantic deduplication without an explicit event identity remains a separate audit.
