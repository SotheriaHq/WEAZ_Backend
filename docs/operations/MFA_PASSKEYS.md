# Passkeys: web and Android rollout

Status: initial backend/web security release verified on SIT on 11 November 2026; current API/SSH reachability is blocked pending server status confirmation; exact signed-APK and real passkey ceremony acceptance remain open. Native Apple passkeys are deferred by the product owner. iOS keeps authenticator and recovery-code methods; supported web browsers can use website passkeys independently of native Apple setup.

The live website association now returns application/json with the privately signed Android certificate and both handle_all_urls/get_login_creds relations. The initial live backend check reported web and Android passkeys configured. A fresh independent Google Digital Asset Links check on 11 November returned linked=true for both relations. Configuration and association are not proof of a successful device ceremony. Behavioural thresholds remain observational during initial calibration; MFA/authorization enforcement is independent.

## Configuration and signing

1. Provision `SECURITY_FACTOR_ENCRYPTION_KEY` securely on the backend for authenticator secrets. Preserve the previous key during an intentional key rotation. Never put a key in a client bundle, tracked file, support ticket or chat.
2. Set `SECURITY_PASSKEY_RP_ID` to the actual relying-party hostname, and `SECURITY_PASSKEY_ORIGINS` to its exact HTTPS website origins. No wildcard, URL path or unrelated domain is accepted. HTTP localhost is an explicit development exception.
3. Build Android with WIEZ's private release signing key. Read the SHA-256 certificate of the exact APK users install; do not substitute an upload certificate if Google Play uses a different app-signing certificate. The public React Native template debug key is refused by the server and website association generator.
4. Put each approved certificate's canonical base64url SHA-256 bytes in `SECURITY_PASSKEY_ANDROID_ORIGINS` as `android:apk-key-hash:<hash>`, comma separated. These are public certificate fingerprints, never private signing-key material. Keep test and production origins separate.
5. The website keeps the verified release certificate in `public/.well-known/assetlinks.json`. Its generator validates and publishes that public file when no build override is supplied. An explicit `ANDROID_APP_LINK_CERT_SHA256` list supplies reviewed rotation/Play certificates in colon-separated hexadecimal; `ANDROID_APP_LINK_PACKAGE` defaults to `com.wiez.wiez`. Both `delegate_permission/common.handle_all_urls` and `delegate_permission/common.get_login_creds` must remain present. The latter relation is required for Android Credential Manager; App Links alone are insufficient. No private signing key belongs in this file.
6. Verify the deployed `/.well-known/assetlinks.json` is JSON served over HTTPS without redirecting to the application shell, names the installed package and signing certificate, and contains both relations. Verify the server's trusted Android origin uses those same certificate bytes.
7. Build a new APK containing the pinned native module. Updating JavaScript in an old APK cannot add this module. An unsupported or older installation shows the alternate-method state rather than crashing. Do not uninstall a user's app or discard local drafts to refresh association caches.

The existing EAS keystore was verified on 2 November 2026. On 10 November, the actual installed Android APK certificate matched the GitHub `ANDROID_SIGNING_CERT_SHA256` pin: `69:15:9A:7F:5B:76:C4:FE:16:F0:8C:4F:39:A1:11:72:38:F4:43:65:8E:2D:F7:DE:B3:7C:E3:2D:4F:2D:9E:04`. The versioned website association names this certificate. Signing readiness is distinct from deployed association and a successful real passkey ceremony; both still require release acceptance. Preserve app data during updates. Never add a public debug certificate to production trust.

Native Apple associated domains, entitlements, identifiers and developer-account setup are explicitly deferred. Do not block web or Android work on them or advertise native iOS passkeys in this release.

## Interaction and failure behavior

- Fetch options before showing the explicit Create/Use passkey action. Invoke the system ceremony from that user action, rather than automatically after a network response.
- A cancelled, expired, closed or account-switched prompt cannot forward a late credential response to verification. The native SDK cannot dismiss Android's prompt programmatically; the result is discarded after cancellation, and a competing ceremony cannot open.
- If a device credential was created but confirmation could not reach WIEZ, retry confirmation with the same response in transient memory. Do not create additional credentials automatically. If the server already committed, close and refresh the method list before starting another setup. No secrets survive a refresh.
- New recovery codes are shown once. Done requires the save acknowledgement. Closing with unsaved codes warns the user; leaving without saving requires explicit confirmation. Forced account/session invalidation still clears private state immediately.
- Keep authenticator and unused recovery-code alternatives. Do not remove the last verified method until a replacement is verified. For complete loss, use the separate two-administrator recovery process; email alone never disables MFA.
- A passkey is bound to one account. Duplicate/cross-account registration returns a generic conflict without disclosing its owner. An expired or exhausted challenge requires restarting the intended action.
- Registration and assertions require the expected RP, exact allowed origin and user verification. The transport envelope is capped at 128 KiB with smaller bounds on encoded fields before cryptographic work. Five failed attempts exhaust a challenge; failed registration counts persist. Zero counters from synced passkeys are allowed by the verifier; challenge replay is still rejected.

## Release acceptance

Local tests verify signed P-256 assertions and none-attestation registration through the actual WebAuthn server library. They are not evidence of a working browser/phone association, a real biometric prompt, real signing-key configuration or deployed enforcement.

Before mandatory rollout, complete the security work queue, integrate the latest SIT changes, review migrations/configuration, and test web desktop/tablet/mobile browsers, embedded Studio and the actual privately signed Android build. Cover cancellation, unsupported device, resume, account switch, wrong origin, expired/exhausted challenge, lost network after confirmation and last-method replacement. Production needs at least two independently authorized recovery reviewers and a rehearsed support runbook. Only current SuperAdmins in explicitly configured SIT/UAT use the approved test exception; other roles and environments retain the two-reviewer rule.

Evidence belongs in the screen-state matrix and the generated local-verification artifact. Do not infer live readiness from an old test report.

References: [Android Credential Manager prerequisites](https://developer.android.com/identity/credential-manager/prerequisites), [SimpleWebAuthn server verification](https://simplewebauthn.dev/docs/packages/server), [SimpleWebAuthn browser ceremonies](https://simplewebauthn.dev/docs/packages/browser), [native module setup](https://github.com/peterferguson/react-native-passkeys), [OWASP MFA recovery and factor changes](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).

## Owner-run phone checks

The signed build can be installed by the owner while USB debugging is unavailable. Preserve app data; do not uninstall or clear storage. The release record must identify the exact APK/tag being tested. No computer connection is needed for ordinary acceptance.

1. Sign in, then open Settings → Account & Security. Open View sessions for the current installation. The separate window must show Active sessions and Recent sign-in history; Close and Android Back return to the same Settings screen.
2. Open a second device if available. Sign out one non-current session from its window, then confirm that session loses access while the current phone remains signed in. Never use sign-out-all as a prerequisite to ordinary testing.
3. From MFA settings, try a cancelled authenticator/passkey setup first. Cancellation must leave the account usable and show no unfinished method as verified. If choosing to enroll a method, save recovery codes privately; never send the code, QR, secret or recovery-code screen in feedback.
4. On supported Android, create and use a passkey through the system prompt. Test cancel and reopen. If unavailable, verify the screen offers the authenticator/recovery alternative without a crash. Native Apple passkeys remain deferred.
5. If the system challenges the actual phone session while entering Studio, verify that phone session and resume Studio. A child Studio session must not clear another session's challenge.

For a failure, report APK tag, screen, action, expected result, actual message and time. A screenshot must exclude secrets. Logs can be captured later if these details are insufficient. Owner-run acceptance remains pending until reported; automated checks do not imply a successful biometric ceremony.

11 November operational update: the owner confirmed the AWS account is suspended. Live API/deployment/physical integration acceptance remains deferred until infrastructure is restored or migrated. Locally verifiable work may continue in checklist order. The privately signed APK apk-4496824 passed GitHub build42986923842 and is published; its phone acceptance is not claimed. Do not retry deployments against the suspended server or present historical live checks as current availability.
