# Custom-order notification claims

Dispatchers claim only the next group of at most10 events, using one atomic
`UPDATE ... RETURNING` with ordered `FOR UPDATE SKIP LOCKED`. Claim eligibility
and expiry use the database UTC clock. Current payload/recipient facts come from
the winning claim, without a separate stale scan.

Each claim has a unique owner and60-second lease. Success, skip and failure writes
match that owner and PROCESSING state; an old worker cannot overwrite a newer
claim. Expired work is recoverable. A crash on the eighth attempt is moved to an
explicit exhausted failure, rather than remaining PROCESSING indefinitely.
Transient failures back off. Queue handoff has a five-second budget and its timer
is cleared on every path. Stable job IDs contain no colon.

The outbox UUID is also the notification UUID. Redis acknowledgement loss can
retry the job, including after BullMQ auto-removes the previous completed job;
the notification processor reuses the same inbox identity. External delivery is
at least once. This is not an exactly-once device/email transport guarantee.
The wider inbox-to-channel transaction/durability review remains open.

## Verification

25October2026: actual PostgreSQL/Redis fixture32cases PASS with cleanup, including
32competing claims, unexpired refusal, expired recovery, old success/failure
fencing, final-attempt crash recovery, backoff and a locked FIFO head. A real
isolated Redis/BullMQ queue plus the actual notification processor verify lost
acknowledgement/retry with one persisted inbox notification. The isolated queue
and disposable database are removed; the user's Redis container is retained.

50tests across the three affected service suites passed together. A subsequent
focused six-test dispatcher run adds the stalled-handoff/timer-cleanup case;
there are51distinct affected tests across those runs, not one fresh51-test run.
Full backend types and modified dispatcher/helper lint pass. Physical-device
delivery and the remaining email/push/conversation/financial races remain open.

```powershell
$env:VERIFY_LOCAL_REDIS_OUTBOX='true'
node scripts/verify-checkout-media-batching.cjs
```

Redis must be loopback. The test uses the existing queue connection resolver and
a unique `wiez-outbox-regression-<UUID>` queue. It never clears application queues.

## Rollout dependency

Migration `20261025193000_custom_outbox_claim_lease` adds claim fields and the
status/expiry index. It has only been applied to disposable regression databases.
Drain old workers before applying this migration and starting the new dispatcher;
older workers do not implement claim ownership. Existing PROCESSING rows receive
the one-time expiry default from the migration, so no old-data branch is needed
in the new runtime. Do not repeat the completed SIT/local application reset.

- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)
- [BullMQ job IDs and removal](https://docs.bullmq.io/guide/jobs/job-ids)
- [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html)
