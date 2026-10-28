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
