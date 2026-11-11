# Reviewed verification recovery

MFA means multi-factor authentication: another proof of identity beyond a password. Account recovery is a security operation, not a customer-service shortcut for disabling MFA.

## Account holder

Open Settings → Password/security → verification recovery on web or native. A password-authenticated account with a verified email can submit a short explanation. Do not include passwords, card details, authenticator keys or recovery codes.

The request can be waiting for review, awaiting more information, approved for replacement, rejected, cancelled, expired or completed. The screen shows the actual server state and expiry. Refresh after a support interaction. Sending more information starts a new revision and requires two fresh approvals.

Existing methods remain active while review or replacement setup is unfinished. A request is not approval. An approved request still requires the account password, a session-bound email code and a working replacement authenticator. The email proof is one-use. It does not approve a payment or another protected change.

After the replacement code is confirmed, one database transaction retires previous methods and recovery codes, ends other sessions and issues fresh recovery codes. The confirming session and its native source remain available so the account holder can save the new codes. Those codes are shown once. Other sessions lose access through the live session check.

## Independent reviewers

Open Administration → Verification recovery. Reviewing requires `users.mfa_recover`, granted deliberately by a SuperAdmin. Ordinary administrator creation does not include this permission. SuperAdmins hold it implicitly; self-review is still forbidden.

Two different authorised administrators must independently establish account ownership. Each decision requires an exact, one-use MFA approval. One reviewer cannot provide both approvals. The service rechecks each approving reviewer's active status, role, credential revision and recovery permission before allowing replacement.

Use independently verified ownership evidence, such as previously verified identity records where available and a separately verified established account contact. Email access, knowledge of public profile information, an urgent story or a current password alone are insufficient. If evidence cannot establish ownership, reject the request. The system records the reviewer and evidence reference; the attestation checkbox does not perform identity proofing for the reviewer.

Keep evidence in a restricted support case, using the private reference field here. Do not paste documents or credentials into the reference. Requests for information and rejection explanations are visible to the account holder. Resubmission invalidates approvals of an older revision.

Before enabling production recovery, establish at least two independent eligible reviewers with working verified methods. Production never waives independent review because a second reviewer is unavailable. Document access controls and retention for the external evidence system; this workflow is not an identity-document collection service.

## SIT/UAT SuperAdmin policy

Only a current database-verified `SuperAdmin` in server `APP_ENV=sit` or `APP_ENV=uat` is exempt from mandatory sensitive-view/exact-action MFA and independent recovery reviewers. `NODE_ENV` is not the deployment tier: SIT runs production Node builds too. Missing, production and unrecognised deployment tiers retain normal requirements. Admins, brand accounts and shoppers retain their requirements in every tier. A request header, device hint or client role cannot select this exception.

The exception does not waive authentication, session revocation/expiry, current role and permissions, resource ownership or a behavioral session challenge. Authenticator/passkey enrollment remains available. Recovery still checks the current password, verified email, one-use session-bound email proof and a working replacement authenticator before retiring old methods or sessions. The request displays zero required independent approvals; no administrator reviews are fabricated. For a previously pending or information-requested SuperAdmin case, enter the password and select **Continue recovery** on web or native. The server rechecks eligibility, uses the existing case and preserves its original expiry. Switching to production requires two live independent reviews even for an unused request approved under the test policy.

## Limits and recovery failures

- An open request lasts seven days. Approval lasts at most 24 hours and cannot extend past the request's expiry.
- Recovery email challenges last at most ten minutes, remain bound to the requesting session and allow five failed attempts. Issuance is limited to three per request in fifteen minutes.
- At most one open request exists per account. Three new requests are allowed per credential revision in a day, with an additional HTTP limit. A credential change invalidates an older request.
- Cancellation or expiry does not remove a verified method. An unfinished setup is not a replacement.
- A suspended/deleted/demoted reviewer, changed reviewer credentials or revoked recovery permission prevents use of an outstanding approval. Cancel the unusable request and begin a new independent review.
- Concurrent review conflicts return a conflict response. Refresh before retrying; a rolled-back decision has no approval effect. Do not blindly repeat money operations after any network failure.
- Security notices are written to the transactional email outbox. Codes, setup keys and approvals must never be put in URLs, logs, analytics or error reports.

## Release acceptance

Backend, web, native and database changes must be integrated together. Verify the complete [screen/state matrix](../security/MFA_SCREEN_STATE_MATRIX.md), current session-binding cutover, encryption configuration, actual email delivery and physical device journeys before enabling mandatory verification. Local disposable-database tests are not production or device acceptance.

The workflow follows the recovery principles in the [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) and [NIST authentication and authenticator management guidance](https://pages.nist.gov/800-63-4/sp800-63b.html). This is not a claim of a particular NIST assurance level.
