# Bulk-import review notification handoff

An import checkpoint must remain unfinished until its review notification inbox and durable channel instruction have been saved. A delivery-provider failure is handled by the existing channel retry engine; it does not undo a saved inbox. A failure to persist the handoff must fail the import page so its existing checkpoint can be retried.

`ContentIntegrityService.flushContentSubmittedNotifications` retains failed events, reports their operational alerts and throws if any handoff failed or returned no result. Successful sibling notifications retain their stable submission-derived identities. Retry reuses those identities without duplicating their inbox or channel instruction. A successful policy opt-out is a handled result. A missing notification dependency must not silently discard pending work.

The bulk PostgreSQL fixture measures producer work with the immediate channel dispatch optimization paused; channel worker recovery is verified separately. Its push payload builder uses the production implementation. Product fixtures create the primary collection pointer and its primary membership in one transaction, satisfying the deferred integrity constraint.

## Verification — 27 October 2026

- 19 actual disposable PostgreSQL scenarios passed, including a real channel-outbox CHECK failure, inbox rollback, unfinished checkpoint, successful retry, 26 distinct review inbox/channel intents and stable replay. Cleanup passed.
- For the 26-row review retry: two shared policy reads, two publication-context reads and one audience read; handoffs committed before the interruption are reused.
- Six payment-admission and five submission-handoff unit cases passed. Admission fixtures now model the native current-capture lock, current-session/line reads and joined custom-order context. Production locking was preserved.
- Backend TypeScript and affected source/test lint passed.
- These checks do not certify live provider delivery, native-device notifications, all race conditions or the final integrated release.

Evidence: `docs/performance-reviews/bulk-import-postgres-2026-10-23.json`. Run `node scripts/verify-bulk-import-postgres.cjs` only with a loopback PostgreSQL connection; the fixture creates and removes its own uniquely named database. Do not reset an application database for this verification.
