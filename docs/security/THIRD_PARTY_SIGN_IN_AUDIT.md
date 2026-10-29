# Third-party sign-in and redirect audit (2026-10-29)

Scope: Google sign-up/sign-in on web and Android, account linking, and every
place a URL or path from a request can decide where a user is sent.

## How sign-in works

There is no server-side OAuth redirect flow. Each client obtains a Google ID
token and posts it to `POST /auth/google`; the backend verifies it.

| Client | How the ID token is obtained | Redirect target |
|---|---|---|
| Web | Google Identity Services, JavaScript callback (FedCM/popup), no `login_uri` | None. Google checks the page origin against the web client's Authorized JavaScript origins. |
| Android | `expo-auth-session` authorization code + PKCE, code exchanged in the app | `com.wiez.wiez:/oauthredirect`, registered on the Android OAuth client (package + signing SHA-1) |

## Checks that pass

| Check | Where |
|---|---|
| ID token signature, `exp`, `aud` in an exact client-ID allow-list, `iss` is Google, `email_verified` true | `auth/helper/google-token-verifier.service.ts` |
| Login screen never creates an account; signup screen never logs into an existing one | `auth.service.ts` `googleAuth` (`GOOGLE_NO_ACCOUNT`, `EMAIL_ALREADY_EXISTS`) |
| Linking from settings requires the signed-in account's email | `auth.service.ts` `linkGoogle` |
| PKCE on the native code exchange; no client secret in the app | `threadly-mobile/src/auth/useGoogleIdTokenRequest.ts` |
| Auth cookies `httpOnly` + `SameSite=Strict`; CORS is an exact origin list and rejects other origins before the handler runs (blocks cross-site login posts) | `auth/helper/general.helper.ts`, `main.ts` |
| Paystack checkout ignores a client `callbackUrl`; subscription `callbackUrl` must match a configured web origin exactly | `payment.service.ts` `resolveCallbackBaseUrl`, `subscriptions.service.ts` `callbackUrl` |
| Native app ignores `next` on auth links and screens incoming paths for control characters | `threadly-mobile/src/utils/authLinkRouting.ts`, `navigationInput.ts` |

## Findings and fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | **Pre-account takeover.** Anyone could register the victim's email with a password (password login does not require a verified email). When the victim later chose "Continue with Google", the Google identity was linked to that account and the attacker's password kept working. | Linking into an account whose email was never verified now removes its password, deletes its refresh tokens and bumps `authVersion` (same as a password reset). A verified account is linked unchanged. |
| 2 | Medium (not exploitable on SIT) | Mobile verification and reset email links took their host from the request's `Host` / `X-Forwarded-*` headers when `APP_PUBLIC_URL` was unset — the token would be emailed pointing at a host the caller chose. SIT sets `APP_PUBLIC_URL`, binds the API to 127.0.0.1 and Caddy only answers `api.weaz.me`. | Outside local development the request is never used; without `APP_PUBLIC_URL` the link falls back to the configured web URL. |
| 3 | Low (defence in depth) | `next` / `returnTo` checks accepted `/\evil.com` (backend, web `next` readers) or any `/…` including `//evil.com` (web Login). The locked react-router 7.18.4 already keeps these on-site (fixes for CVE-2026-40181, CVE-2026-53669). | Backend `sanitizeAuthNextPath` and web `toInternalPath` parse against a probe origin and reject backslash and control characters; all five web readers use it. |

## Residual risk (not changed)

- **Google not authoritative for non-Gmail addresses.** Google says it is
  authoritative only for `@gmail.com` addresses or when `hd` (Workspace) is set;
  otherwise it recommends a password or other challenge before linking, because
  the third-party mailbox may have changed hands. Login-time linking does not
  challenge today. Closing this needs a client flow (email code before linking),
  so it is recorded rather than changed here.
- **No nonce.** ID tokens are bound to our client IDs by `aud` but not to a
  server-issued nonce, so a leaked token is replayable until it expires (about
  an hour).

## Owner checks (Google Cloud Console, project `wiez-507910`)

1. Web client: Authorized JavaScript origins are exactly the production and SIT
   web origins (e.g. `https://weaz.me`, `https://www.weaz.me`); no wildcards,
   no stale preview hosts. Authorized redirect URIs can be empty.
2. Android client: package `com.wiez.wiez` with the SHA-1 of every signing key in
   use (CI release key and, after Play upload, the Play app-signing key).
3. `GOOGLE_ALLOWED_CLIENT_IDS` on the server lists only these clients.
4. `APP_PUBLIC_URL` is set in every non-local environment.

Sources: Google, "Verify the Google ID token on your server side"
(developers.google.com/identity/gsi/web/guides/verify-google-id-token);
RFC 9700 OAuth 2.0 Security BCP (redirect URI exact matching, open
redirectors); GitHub advisories GHSA-wrjc-x8rr-h8h6 (react-router).
