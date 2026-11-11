# Adaptive authorization and session risk

Status: security changes are merged and the initial SIT release was verified; current API/SSH reachability is blocked, and physical client acceptance remains in progress. Source tests are not evidence that every endpoint, client or provider path is production ready.

## Current SIT release — 11 November 2026

Backend release 4b6d6e8 is deployed through GitHub Actions. Its full quality gate, secret scan and deploy gate pass. At the initial successful deployment, the API and worker were online; additive migrations completed, the schema-repair marker is clear, and the existing payout bank claim is prepared. Local additive migration and claim preparation also completed without resetting or reseeding either database.

Web security PR47 is merged; live weaz.me publishes the Android association as JSON with both required relations and the verified release signer. Native security PR56 is merged into SIT8c8c769 and its signed GitHub APK apk-8c8c769 built successfully. The device-session modal refinement is merged in web PR49 (SIT fa7fe09) and native PR58 (SIT4496824); signed APK apk-4496824 is building. Physical screen/ceremony acceptance remains open and is delegated to the owner while the phone is in use; no USB connection is required for ordinary acceptance. Native Apple passkeys remain deferred.

Live SIT checks verify unauthenticated denial, verified administrator sign-in with session/revision-bound access tokens, configured MFA status, two sign-ins grouped on one device with credential-free session details, and immediate access-token revocation on logout while another session stays valid. These are bounded smoke checks, not a load/capacity result or full UI acceptance. The managed administrator completed verification through the actual replacement inbox.

Behavioural thresholds run in observation mode for initial calibration. Mandatory current identity, authority, ownership, revocation and factor requirements remain independent of this setting. Country/time alone are not attacker proof; no unconfigured IP-reputation or geolocation provider is claimed. Production retains mandatory MFA and two-reviewer recovery. Only current SuperAdmins in explicitly configured SIT/UAT receive the approved test exception.

Current local verification:234 real PostgreSQL/Redis/HTTP/socket scenarios with cleanup;855 backend tests across87 suites in a separate overlapping run;78 native/paired checks without skips; both client typechecks; native border/design audits; two independent bounded client-curation reviews. GitHub also passes the integrated source/build/lint and broader backend regression gates. Earlier dated component checkpoints below are historical and do not override this release status.

Remaining release acceptance: supported-browser/device MFA setup and passkey ceremonies, private Studio parent-session recovery, and current signed-APK screens. Live financial-provider charge/failure behavior has protocol and signed/transactional fixture evidence; it is not presented as a live-money acceptance test.



### Current operational blocker

The later SIT backend deployment run42985982317, commit1833b16, failed before its remote script could start: SSH connection timeout. A fresh browser/Node API check and direct SSH check also timed out, while the website remains reachable. The earlier successful deployment and smoke evidence below must not be interpreted as present API availability. Verify EC2 instance state, status checks and its current public address before retrying deployment. No reset, data deletion, firewall bypass or unverified host substitution is part of this check.

## Product requirements

The first mandatory rollout covers platform administrators and brand finance/security actions. Server identity, current authority, tenant ownership and resource access remain mandatory regardless of a low risk score. Time of day, country, network changes and device hints alone must not identify an attacker or bypass authentication.

Sensitive viewing uses a five-minute stronger-authentication window. Critical money movements, payout-account changes and permission changes require a separate one-use approval for the exact operation. A viewing approval cannot authorize a mutation.

The approved test policy exempts only a current database-verified SuperAdmin in server `APP_ENV=sit|uat` from mandatory MFA and two-reviewer recovery. Production, unknown tiers and every other role retain normal requirements. This never bypasses session revocation/expiry, current authority, ownership or a behavioral risk challenge. Test recovery still requires password, session-bound verified-email proof and a working replacement. See [recovery policy and interactions](../operations/MFA_RECOVERY.md#situat-superadmin-policy). The client displays the server's requirement; it cannot enable this policy.

Subscription upgrade quotes hold the displayed price for five minutes while identity verification completes. An expired uncommitted quote requires a new price and approval before charging. Quote persistence and coordinated checkout/client contracts are implemented locally; integrated MFA/provider/client release acceptance remains outstanding.

Scheduled downgrades retain the recurring price approved when scheduling, even if the catalogue changes before renewal. This separate product decision was confirmed on 2 November 2026. The scheduled price is a financial agreement snapshot, not a live catalogue lookup.

Group sessions by installation/browser while allowing individual-session revocation. Keep credential-free ended-session history for thirty days. Session-bound access tokens require the already-approved fresh sign-in at cutover.

### Session transitions and logout

Private responses belong to the sign-in that sent them. Web desktop/tablet/mobile and native transports reject late results after a session change, including late successes, failures and refreshes. Routine JWT rotation inside the same bound session remains valid. Cleared read caches cannot be refilled by an older request. Cross-tab storage changes are a signal to clear this tab's private state and verify cookies with the server, never proof of a user's identity; receiver failure must not delete a healthy sender's shared sign-in snapshot.

Web authentication writes and refresh share a local queue and, where available, the browser's same-origin Web Lock. This orders HttpOnly cookie changes; rejecting a JavaScript response alone cannot retract a cookie already applied by the browser. Browsers without Web Locks retain local serialization and server credential validation, but do not gain a cross-tab lock guarantee.

Logout is an idempotent, rate-limited credential-revocation operation. A correctly signed, session-bound access credential may revoke its own session even after access expiry. This exception grants no access to ordinary endpoints, issues no tokens and cannot select another user/session. A current opaque refresh secret can also prove revocation; consumed secrets cannot. Explicit bearer credentials never fall back to unrelated browser cookies. Cookie clearing requires cookies matching the revoked session, preserving a newer session in another tab. See [session cutover and verification](../operations/SESSION_AUTHORITY_CUTOVER.md).

## Implemented controls

- The access decision engine validates fresh authority, session/risk bindings and exact proof scope. Risk state cannot grant missing permissions.
- The session-risk engine orders observations, retains confirmed compromise/revocation and rejects mismatched evidence. Behavioral thresholds initially run observationally pending calibration.
- An operation fingerprint binds actor, session, authority revision, HTTP method, resource address, route template, body, resolved brand, policy scope/sensitivity/action and required administrator permissions. Permission order/duplicates do not alter that requirement.
- Brand identifiers are resolved on the server before admission. Domain resolvers reject a brand that differs from the approved operation. Client headers cannot select an authorization policy.
- Critical protected writes recheck current authority and consume approval in the same transaction as the change. Rollback restores the approval and effect together. Concurrent requests cannot share a one-use proof.
- Request authority ends on HTTP completion, error, unsubscribe, disconnect or abort. A transaction also has its own lifetime. Detached work cannot reuse a completed transaction or inherit approval to open another one. Cancellation before commit rolls back protected writes.
- Nested protected work shares its live transaction. Ordinary worker transactions retain their existing execution path; this is not a claim that all service-to-service identity requirements are implemented.
- Payout dispatch rechecks the committed lease and amount/currency/recipient/reference before provider HTTP. Outcome recording and uncertain-result bookkeeping use that locked intent fence independently of a completed/revoked human request. A lost lease permits only late-response audit, never overwriting another executor's state. No provider HTTP call holds that transaction open.
- Payout-account setup requires a live approval specifically for that action. It cannot inherit a proof for another financial operation or dispatch provider HTTP from an enclosing transaction. Current account/version, explicit bank input, actor and resolved brand are checked at admission; the command and provider checkpoints are encrypted with account/attempt/purpose binding.
- V1 permits one WIEZ brand per payout bank account. A unique HMAC bank reservation and indexed release-readiness gate enforce this under concurrency; sharing remains deferred to V2. Paystack's documented duplicate-recipient reuse is preserved. Unknown subaccount creation is reconciled without blind resubmission. Recipient retirement waits until committed replacement and payout dependencies permit it. See [payout-account operations](../operations/PAYOUT_ACCOUNT_SYNC.md) for configuration, preparation, recovery and live-provider acceptance requirements.
- Primary owners and active co-owners use the same canonical ownership predicate, including transaction-bound checks. Suspending a co-owner removes access despite a previously established strong-authentication window.
- New subscription instructions require a live action context for their actor, brand and exact route. Cancellation and renewal-card changes consume approval in the same transaction as their writes and transactional notice. Checkout persists an actor/brand/tier-bound quote for five minutes, including the exact amount, recurring price and material agreement version. Approval binds the saved quote and selected card credential version; consuming it and admitting the payment command commit together. Expiry or material changes require a fresh quote and approval.
- Checkout has an invoice-specific encrypted command and exclusive expiring execution lease. It saves dispatch before provider HTTP, reconciles submitted references instead of replaying an uncertain debit, and fences late outcomes. Recovery uses the committed instruction even after the initiating session ends; the HTTP caller must still pass a fresh authority check before receiving private billing data. Zero-charge changes use the same durable admission/recovery path without provider HTTP. See [checkout operations](../operations/SUBSCRIPTION_CHECKOUT_RECOVERY.md). Integrated MFA/client acceptance remains outstanding.
- Web and native clients send the quote identifier and exact amount. Their local expiry uses elapsed time rather than trusting the device clock, counts request latency conservatively, clears consent on expiry and provides a fresh-price action. The backend remains authoritative. The checkout contract requires coordinated backend/client release.
- First-factor enrollment requires the existing password and a verified-email bootstrap. Adding another factor requires a new one-use approval, not a viewing window. Seeds are encrypted; recovery codes are random and one-use. Replacement keeps the old authenticator active until the new secret verifies. Removal cannot leave the account without a verified method, including under competing requests. Successful changes invalidate older approvals, unfinished setups and other viewing windows and enqueue a transactional security notice. Unused account recovery codes survive additional enrollment; explicit regeneration replaces them. Passkey signed-fixture/client acceptance remains outstanding.

## Verification checkpoint

3 November local delivery checkpoint: 137 actual disposable PostgreSQL/Redis/loopback HTTP and Socket.IO scenarios pass, with cleanup confirmed; 69 focused read/realtime/lifetime units also pass. Web MFA/auth/realtime checks pass 117 cases across 16 suites at the full-suite checkpoint, and native/paired transport/MFA checks pass 60. These are overlapping suites, not a capacity claim. The HTTP tests withdraw content approval or revoke a session while a body is paused, then verify no private body is returned, including the separate store-collection visibility/unpublish path. An earlier real HTTP failure exposed Nest's `AsyncResource` binding: the handler observable must be created within the resource context, not only subscribed there. The corrected ordering passes the same barrier regression. See [current local evidence](adaptive-access-local-verification-2026-11-03.json). Two independent reviews pass this corrected delivery component. Full endpoint inventory, current-release integration, live-provider and browser/phone acceptance remain open. No deployment is established by this checkpoint.

The 2 November disposable PostgreSQL/Redis/loopback-provider checkpoint passed 99 cases, with database cleanup confirmed. It covers bank/payout/owner/session boundaries, held subscription pricing, durable checkout recovery, MFA lifecycle, independent support recovery and real signed passkey verification. Full backend/web/native types pass at this checkpoint. Web MFA checks pass 87 cases across 12 suites; native runtime/paired contracts pass 12; focused passkey/configuration/conflict units pass 33. Native border/design audits and website association tests pass. Earlier separate billing70/ledger26/refund-payout58 checkpoints remain recorded in their evidence. These counts are separate suites with overlapping coverage, not a combined unique-test or capacity claim. Provider responses were synthetic; application databases and real payment/email providers were not mutated. See the [local evidence](adaptive-access-local-verification-2026-11-02.json). Live-provider, platform association/signing and integrated client/device acceptance remain outstanding.

## Media-link and diagnostic response boundaries

The 5 November direct-file/reviewer checkpoint passed 156 real disposable
PostgreSQL/Redis/HTTP/socket scenarios and confirmed database cleanup. The final
typecheck, 63 focused checks and 21 related checks passed. These suites overlap
and are not a capacity measurement. Two independent reviews passed this scoped
component. See the [dated file-response evidence](adaptive-file-response-verification-2026-11-05.json).

The subsequent private-list checkpoint passed 157 real integration scenarios
with cleanup, 59 focused checks and the full typecheck. Both independent
reviews passed. See the [source-bound media evidence](adaptive-file-source-verification-2026-11-05.json).
Private catalogue batches now retain the design or product that authorized
each file. Completion checks both the current file association and that
entity's permissions. Ownership is not inferred from the uploader. Owner
trash previews require an explicit owner-only constraint; strict and visitor
reads still reject deleted content. All four catalogue callers pass these
constraints; the actual draft-list service has HTTP ownership/detachment
barrier coverage. This does not establish full UI acceptance or large-draft
pagination capacity.

The direct public/authenticated file-ID, key and source-batch lookups register
the file identity, original key, asset version and requested variant. Before
returning a successful read, the API rechecks current file availability and
the same public, owner or shared-file authorization used at admission. Shared
private-design and message-attachment grants are checked in batches by viewer;
variant keys must still belong to the current parent asset version. The owner
variant-preview endpoint preserves processing-status responses for failed or
unavailable files without signing their contents.

Authenticated administrator use of the shared signed-file lookups requires the
five-minute strong-authentication viewing window. The server principal selects
this policy. A client-supplied role cannot select or weaken it. Current session,
role, authority revision and verification expiry are checked after resource
reads, before the response is returned.

Only explicitly annotated, non-mutating POST lookups receive read-response
completion checks. This metadata is bound into the operation fingerprint.
Ordinary commands and critical changes cannot opt into the read gate or replay
their handler through it.

Diagnostics require a current SuperAdmin session and strong authentication.
The metadata endpoint accepts at most 20 files of 8 MiB each, with no form
fields. Its streaming storage counts and discards bytes; it creates no file
buffers or paths. Metadata extraction is limited to five requests per minute
and the Sentry test to three, with quotas shared across replicas. These limits
do not establish sustained upload throughput or heap capacity.

Verification-document signing additionally binds the required evidence file
type. It rechecks availability, version and type before the current review
permission is checked. The actual service was tested in a permission-decorated
HTTP fixture, including withdrawn `brands.verify` access; full Brand
Verification controller/UI acceptance remains required.

The subsequent batch-variant checkpoint passed 160 real scenarios with cleanup,
75 focused checks and typechecking; both independent reviews passed. See the
[variant-response evidence](adaptive-variant-response-verification-2026-11-06.json).
HTTP-read variants check their current parent and active version. Private
catalogue variants inherit their content constraints; standalone calls use
public, owner, shared or a guarded administrator operation. A bare Admin role
on a public route cannot sign private variants. The request retains only a
frozen principal ID/role and clears it at completion. Internal non-read callers
retain their existing contract and require separate command-response audit.

The administrator metadata checkpoint passed 163 real scenarios with cleanup,
71 focused checks and typechecking; both independent reviews passed. See the
[administrator metadata evidence](adaptive-admin-metadata-verification-2026-11-08.json).
Policy selection follows server-declared permissions and administrator-only
roles even outside the admin route prefix. Exact role restrictions are bound
to approvals and rechecked at admission, protected transactions and read
completion. Absent role restrictions differ from an explicitly empty list,
which denies everyone. Public labels cannot clear these restrictions. Own
MFA bootstrap remains reachable for an allowed role without granting access to
admin recovery operations. The non-mutating clock-state POST retains its API
contract and now receives read-response checks. This does not certify the
mutation effects of QA jobs or every private command response.

Draft lists now use bounded keyset pages; their local capacity and isolation
checks are described below. This is not a production throughput measurement.
Granular administrator access to individual private files now uses current
database capabilities and normalized associations, described below. These
scoped checks do not establish complete endpoint or command-response coverage.
A signed URL already issued is a bearer capability until expiry;
response checks prevent newly returned links after a failed recheck but do
not revoke previously issued URLs.

### Current administrator files, commands and evidence retention

The 10 November scoped checkpoint passed 198 real integration cases with disposable-database cleanup, 264 focused backend tests, backend typechecking, 39 web tests and 16 native checks with zero skips. Two independent reviews passed after required-document correction and pending-recovery interaction findings were fixed. See [source hashes and local evidence](adaptive-administrator-files-verification-2026-11-10.json). This is component evidence; the remaining command-response, QA-job, capacity, integrated-release and device/provider gates remain open.

Generic private-file ID, key, source-batch and guarded variant access uses one projected SQL statement over current active role/capabilities and persisted associations. A bare Admin role, raw product image string or MIME type grants no private-file access. Product/design/store-collection, actual content-submission, message-attachment, owned review-media and verification evidence relationships are checked using their appropriate capabilities. System-generated store buckets do not grant collection-review rights. A validated historical evidence manifest preserves the exact file identity after a brand ownership transfer. Current capability and association are checked again before a new link is delivered.

Ordinary administrator writes recheck current session, role, capability, admission-risk age and viewing verification inside their database transaction, before effects and again before commit. Expired verification returns `409 SECURITY_VERIFICATION_RESTART_REQUIRED`: review the current state and deliberately retry; clients never automatically replay it. Critical production changes retain Serializable transactions and exact-operation one-use proof consumption. Physical-verification commands serialize current assignment, visit status and evidence checks with the write; notifications follow commit. Brand replies use the brand-safe projection rather than exposing agent identity or proof media.

Expired-draft and administrator attachment cleanup share the owned-file lock/reference guard. It checks live content, profiles, messages, physical proofs, six exact verification document keys and review media before deleting metadata or queueing storage keys. Original and variant keys are queued together within the transaction. Active processing rolls back draft detachment for a later retry. Referenced evidence is retained while the expired draft itself can be removed.

Verification submission and correction lock uploads while associating them. Corrections validate the entire merged filing: required documents cannot be cleared with empty/null values, and a change to an identity/authority type must include newly required back images or representative proof. Foreign, wrong-type, failed or removed-original files are rejected; a valid original remains usable during asynchronous image processing. Each correction appends a new evidence snapshot and preserves earlier review history. Concurrent corrections cannot append competing attempts from one stale state. These source changes require final combined verification and coordinated release; earlier dated artifacts remain historical checkpoints.

### Command completion, retained sessions and bounded draft pages

Authenticated finite commands now buffer their result until the handler finishes, including HTTP 204 and empty results. Completion checks the current actor, source phone, role, required capabilities, resolved brand access and risk state. It does not create another verification challenge or consume another one-use approval after a committed change. A failed delivery check returns `409 SECURITY_RESPONSE_WITHHELD`: the action may have completed, so the client must check status rather than automatically replaying it. Purpose-specific, request-bound receipts allow logout-all and account deletion to return only their fixed acknowledgement after intentionally ending the caller's authority.

A verified password change retains the current session ID, creation time and device identity while rotating both credentials and advancing the security revision exactly once. Other sessions and Studio children are revoked atomically with the password and notification-outbox entry. The original administrator 24-hour deadline cannot move, even when work awaits before rotation. Delivery checks the exact replacement principal before writing credential cookies. Web adopts only the same subject/session/role at the next revision. Native also coordinates the physical password send and credential adoption with refresh; it releases that barrier while extra verification is open, then restores it for the approved retry. An explicit sign-out or account switch still cancels the old operation. Studio opens the native Password & security screen instead of receiving a phone-parent credential.

Manual cleanup jobs preserve the human operator across each bounded deletion or notification-outbox transaction. Authority is checked before effects and before commit, and loss of authority stops later batches instead of being swallowed as a per-row cleanup error. Provider delivery happens later through the outbox. Nightly cron retains its independent system authority. Manual endpoints accept only explicitly configured local/development/test/SIT/UAT environments; production and missing/unknown tiers are denied.

Draft lists use account-bound keyset cursors ordered by creation time and ID, with 1–100 rows per response. Each page hydrates only its selected cover and media count. Published-title exclusion stays inside SQL rather than loading an unbounded title list. The design alias additionally filters the design domain. The standalone web draft screen provides later pages, retry, full text wrapping and identity-scoped state; deletion failure retains the card. The catalogue's existing optimistic flat-cache contract assembles bounded pages with cancellation and identity checks at request admission and after completion. These changes do not claim a measured maximum account size or traffic capacity.

The current 10 November checkpoint passes 234 actual PostgreSQL/Redis/HTTP/socket cases with disposable-database cleanup. It includes both new draft indexes, stale-revision self-command rejection, four real session-row risk-contention tests and four expiry-after-deletion rollback tests. Cookie tests exercise the actual logout-all controller with foreign-account cookies, matching cookies and a request admitted before a retained-session revision change. Two independent bounded reviews passed the corrected component. Current client evidence includes 35 paired transport cases without skips and four rendered draft-screen cases. Full feature, endpoint/domain, platform/provider and coordinated release acceptance remain separate gates.

Ordinary session-revocation commands lock the account and caller/source session rows before reading authority. Risk observations cannot overtake those locked instructions. Each command checks its original expiry and live request after all awaited writes, before commit; this also covers logout-all's intentional deletion of its own session. Terminal responses clear cookies only after successful completion and only when the presented cookies belong to the exact actor, session and revision. A stale failed command cannot clear replacement credentials.

## MFA client contract

All routes below require the current authenticated, session-bound identity. Setup codes, passwords, secrets, recovery codes and action proofs must never be placed in URLs, analytics, persistent query caches or logs.

| Route under `/auth/security/mfa` | Purpose |
|---|---|
| `GET /` | Verified methods and recovery-code count; never returns existing codes or seeds |
| `POST /enrollment/request` and `/enrollment/confirm` | Password plus verified-email bootstrap for the first method |
| `POST /totp/begin` and `/totp/confirm` | Authenticator setup; optional `replacesFactorId` binds an approved replacement |
| `POST /passkeys/begin` and `/passkeys/confirm` | Passkey registration with required user verification |
| `GET /challenges/:id/passkey-options` | Assertion options bound to the current user, session and pending challenge |
| `POST /challenges/:id/verify` | Exactly one authenticator, recovery-code or passkey proof |
| `POST /factors/:id/revoke` | Password and one-use approval; refuses removal of the last verified method |
| `POST /recovery-codes/regenerate` | Password and one-use approval; returns a new set once |

Protected operations respond with HTTP428 and `code`, `challengeId`, `expiresAt` and `action` when verification is needed. `MFA_ENROLLMENT_REQUIRED` directs first-time setup; `STEP_UP_REQUIRED` identifies an existing-factor challenge. Verification yields a one-use `actionProof` for a critical action, or a five-minute viewing window for sensitive reads. Recovery and verification remain reachable while challenged; an unverified pending method never grants permissions. Old actor/session/action bindings cannot be substituted during a retry.

Clients must retain the exact intended action and any saved quote while verification completes; expiry requires fresh review rather than repricing an old approval. WebView child sessions and native parent sessions are distinct bindings. Display recovery codes only in transient, explicitly acknowledged UI. Passkey availability depends on the actual platform; retain authenticator/recovery fallback.

## Read and realtime delivery boundaries

Finite authenticated GET/HEAD bodies recheck current account/session/revision, applicable administrator/brand grants and the viewing window before emission. Successful canonical content-authorizer checks register request-local resource identifiers and viewer bindings, capped at 1,024 distinct constraints. Completion groups these checks by entity and queries in batches of 100. Private collection approval preserves the canonical owner-scoped rule; a parameterized `JOIN` with database `DISTINCT` avoids loading duplicate grants for every approved collection. Optional-auth public detail routes take the same boundary: anonymous published public content remains available, while a body that became private, lost approval or lost its authenticated session is withheld. Abort, close, error and completion release the resource context; no private bodies, database clients or reusable grant callbacks are retained. Routes with distinct domain authorizers still require the endpoint inventory; this is not blanket resource coverage.

A challenged parent phone session returns `PARENT_SESSION_VERIFICATION_REQUIRED` (428), with its parent session identifier and bounded expiry. Studio pauses and asks the native host to verify that exact root session. The host accepts only a trusted Studio origin, valid request correlation and the matching current native session ID. Cancellation/unmount aborts verification. Neither credentials nor MFA/action proofs cross the bridge. A host acknowledgement only permits one retry: the server checks the parent again, and the child still needs its separate exact-action approval for critical changes. A standalone browser explains how to verify on the original phone and retry. Child MFA cannot normalize its parent.

Realtime namespace authentication finishes before connection/join. Every private emission rechecks content audience and current user/session/parent/revision/expiry in bounded batches. Socket authority uses one scalar SQL `JOIN` per batch of at most 100 sessions. All producers use authorized delivery; no raw-broadcast fallback grants access. Redis fanout preserves per-room order locally with four active deliveries, at most 256 queued jobs, 4 MiB queued data and a 256 KiB frame limit. Pub/Sub is best-effort, not durable delivery; business state remains persisted. Presence remains local-node scoped. Expiry disconnects the socket; same-session refresh reconnects without replacing listeners, while account changes dispose prior rooms. Transient renewal failures use one owned, capped-backoff retry timer, with foreground/online wakeup and cancellation on identity change or disposal.

Browser startup restores its session-bound bearer before profile loading so a legitimate cookie-session challenge can open verification. Cookie-only restoration failures cannot erase another tab's shared identity snapshot. This does not create an unauthenticated profile exception.

## Physical-verification evidence attachment — locally verified 8 November

As a verification agent, I want evidence to refer to my completed uploads so
that another user's private file cannot be presented as evidence from my visit.

The attachment command locks the visit, rechecks its current status and assigned
agent, then locks the exact uploader-owned file. Only a READY upload with an
available original is accepted. The filename, media type and size come from the
stored upload; caller-supplied metadata cannot replace them. Existing proof kinds,
captions and the visit-completed transition are preserved.

The owned-file deletion command checks physical-proof key references under its
file lock. A matching key index supports this retention check. Real PostgreSQL
barriers verify both attachment/deletion orders and concurrent reassignment.
The lock ordering follows PostgreSQL's [row-lock documentation](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

The expanded local matrix passed 169 integration cases with disposable-database
cleanup, plus 30 focused unit checks, backend typecheck and two independent scoped
reviews. See [verification evidence](adaptive-physical-proof-verification-2026-11-08.json).
These counts overlap earlier checkpoints; they must not be added together.

This is not whole-workflow or deployment acceptance. Generic administrator file
permissions remain open. Physical-proof removal and verdict authority/evidence
checks still need execution-time transaction fencing. Other direct deletion paths
(including scheduled design cleanup and administrator data wiping) have not been
certified by this owned-file deletion proof. Existing proof rows are not rewritten
or grandfathered into new administrator read grants by this change.

## Required before release

- Financial provider admission and outcome recording must use a durable, fenced operation. An approved provider operation needs safe reconciliation if the initiating session expires, is revoked or disconnects after admission. Provider HTTP calls must not hold authorization/database locks.
- Bind mutable financial details to the approved operation, including server-resolved amounts, recipient and pricing snapshots where applicable. Verify these at the execution gate; user-facing verification must identify what is being approved.
- Complete subscription mutation coverage. Current co-owner and bank recovery verification does not establish that every other financial route consumes/fences its approval.
- Finish review of the persisted subscription quote, exact quote/card approval binding, provider execution/recovery and all-client contract updates. Focused client checks pass (12 web, 5 native API/timing tests, both typechecks and native border/design audits); final backend/provider regression and integrated MFA/client acceptance remain required.
- Complete actual browser/phone acceptance of the written factor enrollment/recovery/step-up interfaces. Signed passkey fixtures now verify real registration/assertion crypto, bad origins/RP/UV, signatures, counters, replay and attempt exhaustion. Live domain association/private Android signing and all affected client/session/realtime flows remain open. Native Apple passkeys are explicitly deferred; keep iOS authenticator/recovery alternatives. See [passkey rollout](../operations/MFA_PASSKEYS.md).
- Finish endpoint inventory, provider-error/revocation races, coordinated deployment/cutover and real client verification. No blanket endpoint coverage or bug-free claim is supported yet.

## Engineering references

[OWASP transaction authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) calls for an execution-time authorization gate tied to the transaction. This implementation uses that requirement to distinguish permission to start an operation from the durable recording of its outcome.

[OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#changing-mfa-factors) treats factor changes as sensitive and recommends verification with an existing factor and user notification. The implementation separates that permission from the ordinary viewing window. [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server) describes RP/origin, challenge, user-verification and credential-counter checks; real signed fixtures and supported-client acceptance are required in addition to lifecycle tests.

[Paystack single-transfer documentation](https://paystack.com/docs/transfers/single-transfers/) describes a stable transfer reference for reconciliation and retry. Preserve the original reference when resolving an uncertain outcome; never assume a new reference is an idempotent retry. Provider-specific behavior still requires the focused failure/recovery tests above.
