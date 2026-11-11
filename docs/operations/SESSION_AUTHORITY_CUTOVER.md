# Session authority binding and cutover

Status: unreleased security implementation. The product owner approved one fresh sign-in when stable session binding is enabled. No application database reset is required.

Each new `RefreshToken` row stores `issuedAuthVersion`, the account security revision read under the account lock at sign-in. It is a historical issuance snapshot, not a second authority source. Current account state remains authoritative. Refresh must match both; it cannot adopt a later password/role revision merely because the old refresh row has not yet been deleted.

The additive migration `20261102220000_bind_session_authority_revision` leaves existing rows at `-1`. Do not backfill them from the current user revision: that would invent authority for an earlier sign-in. The default intentionally refuses sessions created by an older application version. New issuance explicitly writes the locked current revision.

HTTP/realtime identity resolution, protected transactional operations, Studio handoff creation/exchange, parent-session checks, refresh rotation and risk persistence use the issuance binding. Rotation also refuses a revoked row in its database compare-and-swap. Ordinary rotation does not reset a challenged session's risk state or count as stronger authentication.

## Deployment

1. Review and integrate the complete security release with the current SIT source. Configure its independent JWT/refresh/MFA keys securely and verify all relevant clients have session-bound token support.
2. Apply the additive migration during the coordinated release. Existing rows remain present for orderly cleanup/history, but the new service rejects their missing binding. Announce the already-approved fresh sign-in; do not silently preserve the old credential flow.
3. Deploy the matching server and clients together, then verify fresh sign-in, regular/admin rotation, account/role/password change, native-to-Studio handoff, parent revocation, logout and history. Admin session inactivity/absolute limits continue to apply.
4. Verify that no older server replica continues to serve authentication. An older binary does not enforce the new authority binding.

The migration uses a bounded lock/statement timeout and a constant default. If lock acquisition fails, resolve the contention and retry the release; do not remove the binding to force deployment. No new index is needed for the primary-key session lookup.

## Recovery and rollback

Keep the column and its enforcement when repairing a release. Do not downgrade to an issuer that ignores this binding or infer old revisions as a rollback shortcut. If the coordinated release cannot proceed safely, keep authentication unavailable until a reviewed forward fix is verified; do not admit new sessions through the weaker flow. Existing authorized sessions cannot be reconstructed safely from current role values. A fresh sign-in is the recovery path for an unbound or invalidated session.

Local verification applies the migration to both a fresh disposable database and a pre-existing row in an isolated schema. Barrier-controlled refresh cases change account authority, session risk and parent binding after the initial token read, and assert no new cookies/rotation on denial. This is component evidence, not proof that every endpoint, client or live release is verified.

## Response ownership and revocation acceptance

Deploy the corresponding web/native transport changes with the server logout change. Outgoing logout captures its account credential before local cleanup; it never retries as the next signed-in account. Cookie-backed startup can still queue logout while an older refresh is pending. Session scope includes subject, session ID and authority revision; token expiry/rotation alone does not create a different scope.

`POST /auth/logout` authenticates the credential for revocation itself rather than requiring an unexpired API-access grant. It accepts only a verified HS256 session-bound access token or a current hashed refresh credential. An expired signed token is valid only for destroying its own bound session, never for reading or changing another resource. An explicit invalid bearer does not fall back to browser cookies. Invalid/already-ended credentials receive the same response; only a real deletion emits logout activity. The route has an explicit 12 requests/minute limit. Ordinary APIs retain their expiry check.

Before release verify expired-access logout, logout during rotation/startup, simultaneous account changes, invalid signatures/algorithms, wrong session/subject/revision, consumed refresh secrets, repeated logout, native parent/Studio child revocation and immediate rejection of revoked access. Verify another tab's cookies/shared snapshot survive stale logout and receiver network/500 errors. Check normal same-session refresh and explicitly account-bound push-token cleanup still work.

Local evidence includes real Axios adapter scenarios on both clients, mounted web sign-in/cleanup tests and real Nest HTTP plus disposable PostgreSQL session-revocation cases. This does not substitute for live browser/phone acceptance, response-boundary/realtime audit, current-SIT integration or independent re-review after corrections.

The revocation purpose follows [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009); WIEZ's JSON logout route is not an assertion of a complete OAuth revocation protocol implementation. Same-origin browser coordination uses the [Web Locks standard](https://www.w3.org/TR/web-locks/).

## Delivery-boundary release acceptance

Release the server read/realtime boundary and matching web/native lifecycle together. Verify optional-auth private details and comments with approval withdrawn during hydration, user/role/brand-grant changes during reads, anonymous public access, actual socket expiry/renewal, transient reconnect failure/recovery, room leave/rejoin, cross-node Redis delivery and account-switch cancellation. Request-local resource checks cover the canonical content authorizer; complete the endpoint inventory for separate domain checks before asserting full coverage. Pub/Sub is best-effort and presence remains local-node scoped.

Flag the native parent session while Studio is open. Studio must pause; its own MFA must not unlock the phone. Use the explicit phone-verification action, verify the actual native session, and resume the child once. A critical action still requires its own exact approval. Test cancel, timeout, standalone browser guidance, wrong phone session, untrusted origin, duplicate bridge requests, account switch, page close and late acknowledgements. Bridge messages contain only request/session correlation and a retry hint; the server is always the final authority.

The 3 November local fixture passes 137 real database/Redis/HTTP/socket scenarios with disposable cleanup. It does not establish live provider behavior, Android signing/association, device acceptance, or a deployed coordinated cutover.
