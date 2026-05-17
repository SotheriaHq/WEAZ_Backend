# Google Auth Implementation Plan

## Scope

This plan covers Google signup, Google login, Google account linking, email-first progressive login, Google-only user password setup, web requirements, mobile requirements, backend security, and QA/UAT readiness.

This is G1 only: audit and architecture documentation. It does not implement Google auth, schema changes, migrations, buttons, SDK logic, or backend Google token verification code.

User story: As a Threadly user, I want to sign up or log in with Google so that I can access Threadly without creating a password first, while still being able to securely create a password later if I want email/password login.

## Repositories Audited

- `threadly-backend` (`bthreadly`)
- `Threadly-frotnend` (`fthreadly`)
- `threadly-mobile`

## Current Backend Auth Audit

Files audited:

- `prisma/schema.prisma`
- `src/auth/auth.controller.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.module.ts`
- `src/auth/dto/*`
- `src/auth/helper/general.helper.ts`
- `src/auth/helper/password.service.ts`
- `src/auth/helper/password-policy.helper.ts`
- `src/auth/helper/email-verification-helper.service.ts`
- `src/auth/helper/prisma-select.helper.ts`
- `src/auth/strategy/jwt.strategy.ts`
- `src/common/utils/auth-links.ts`
- `src/common/utils/web-app-url.ts`
- `src/email/email.service.ts`
- `src/email/email.templates.ts`
- `src/email/email.branding.ts`
- `.env.example`
- auth specs under `src/auth/*.spec.ts` and `src/auth/helper/*.spec.ts`

Confirmed findings:

- `User` has a required `password String` field. Google-only users cannot be represented honestly today without a schema change or an unusable placeholder password.
- `User.email` and `User.username` are unique. Email is currently the duplicate-account prevention boundary for local signup.
- There is no `AuthIdentity`, `OAuthAccount`, `SocialAccount`, `googleId`, or auth provider table/model.
- `User` already has `isEmailVerified`, `emailVerificationCode`, `pendingEmail`, `pendingEmailTokenHash`, `pendingEmailExpiresAt`, `mustResetPassword`, and `authVersion`.
- `emailVerificationCode` is currently stored directly on `User`. That is existing behavior for email verification links, but new email-login/password-setup codes must not repeat that pattern.
- `PasswordResetToken` stores `tokenHash`, `expiresAt`, and `usedAt`; it is indexed by `userId`, `expiresAt`, and `tokenHash`.
- Password reset tokens are generated with random bytes, hashed with SHA-256, expire after one hour, are single-use through `usedAt`, invalidate other active reset tokens, revoke refresh tokens on success, and increment `authVersion`.
- Refresh tokens are stored in `RefreshToken` as bcrypt hashes with user agent, IP, last-used, expiry, and created/updated timestamps.
- JWT payloads include `authVersion`; `JwtStrategy` rejects tokens whose version no longer matches the current user.
- Authenticated password change verifies the current password unless `mustResetPassword` is true, applies the shared password policy, updates the password, clears `mustResetPassword`, increments `authVersion`, revokes other refresh sessions, and sends the existing password-changed alert.
- Email/password signup validates the shared password policy, hashes with Argon2id, creates `UserProfile`, creates `Brand` plus owner membership for brand signups, sends email verification, and immediately issues auth tokens.
- Email/password login accepts `email` or `identifier` plus `password`, verifies the Argon2id password, rejects inactive/suspended users, rejects admin first-login reset-required accounts, then issues access/refresh tokens.
- Existing login does not use an email-first method-resolution endpoint.
- Existing login does not require `isEmailVerified` before issuing a session.
- `AuthController` exposes `/auth/login`, `/auth/signup`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/profile`, password reset endpoints, email verification endpoints, email-change endpoints, session/device endpoints, and account deletion.
- `PasswordService` uses Argon2id for user passwords.
- `TokenService` issues access tokens and random refresh tokens, stores refresh token hashes, rotates refresh tokens, and returns refresh tokens to mobile clients via the `x-client-platform: mobile` header path.
- Email delivery uses `EmailService.send()` and the email outbox model. Auth service wraps scenario-aware sends through `sendScenarioEmailIfAllowed()`.
- Existing templates include password reset, email verification, confirm email change, password-changed security alert, admin account created, staff invite, and account/reactivation emails.
- `resolveWebAppBaseUrl()` uses `WEB_APP_URL`, then `FRONTEND_URL`, then local fallback from `WEB_APP_USE_HTTPS`, `WEB_APP_HOST`, and `WEB_APP_PORT`.
- `src/common/utils/auth-links.ts` centralizes reset, admin reset, email verification, and email-change confirmation web links.
- Current backend package dependencies do not include `google-auth-library`, Passport Google strategy, or other Google token verification libraries.
- Current auth test coverage includes profile mapping, signup profile creation, auth response data exposure, password reset hardening, reset token reuse/expiry, reset security alerts, and `authVersion` behavior.

Audit risk:

- The current backend working tree has an uncommitted `.env.example` edit containing Google OAuth-looking values, including a client-secret-looking value. This file must not be committed as-is. Rotate any real secret that was pasted there, remove the secret from the example file, and replace with placeholder names before G2.

## Current Frontend Auth Audit

Files audited:

- `src/App.tsx`
- `src/pages/Login.tsx`
- `src/pages/SignUp.tsx`
- `src/pages/ForgotPasswordPage.tsx`
- `src/pages/ResetPasswordPage.tsx`
- `src/pages/EmailVerify.tsx`
- `src/pages/ChangeEmailConfirmPage.tsx`
- `src/context/AuthContext.tsx`
- `src/api/AuthApi.ts`
- `src/api/httpClient.ts`
- `src/config/env.ts`
- `src/lib/passwordPolicy.ts`
- `scripts/test-auth-link-route-contract.cjs`
- `package.json`
- `.env.example`
- focused auth-link tests under `src/__tests__/`

Confirmed findings:

- Routes are centralized in `src/App.tsx`.
- `/verify-email` and `/change-email/confirm` are public route entries outside the guest-only and protected groups.
- `/login`, `/signup`, `/forgot-password`, and `/reset-password` are under `GuestRoute`.
- `/admin/reset-password` and `/admin/force-reset-password` exist for admin recovery.
- Current web login renders email and password fields at the same time. It is not email-first and does not resolve sign-in methods after Continue.
- Current web login posts directly to `/auth/login` with email and password.
- Current web login has visible Google and Apple social buttons, but they are static `type="button"` controls with no SDK or API handler.
- Current web signup renders regular/brand selection, first/last name, optional brand name, email, password, confirm password, and terms. It posts to `/auth/signup`.
- Current web signup has visible Google and Apple social buttons, but they are static `type="button"` controls with no SDK or API handler.
- `AuthContext.login()` posts directly to `/auth/login`; it does not expose Google auth, login-options, email code, or password setup methods.
- `AuthApi` contains password reset/change, email change, session management, delete account, and admin reset helpers. It does not expose Google auth, login-options, email-login-code, or password setup helpers.
- `src/lib/passwordPolicy.ts` uses a 12-character minimum and shared UI copy for reset/password-change surfaces.
- `SignUp.tsx` currently uses a local zod minimum of 6 characters, while backend and shared web password-policy helper use 12. The backend blocks weak passwords, but G4 should align signup UI validation with the backend policy while touching auth UI.
- Web package dependencies include React, React Router, Axios, Zod, React Hook Form, and existing UI/testing tooling. There is no Google Identity Services wrapper dependency.
- Current tests cover reset-password and change-email confirmation; auth-link route contract coverage exists. There is no progressive-login or Google auth test coverage yet.

## Current Mobile Auth Audit

Files audited:

- `app/(auth)/login.tsx`
- `app/(auth)/signup.tsx`
- `app/(auth)/_layout.tsx`
- `app/(auth)/forgot-password.tsx`
- `app/(auth)/reset-password.tsx`
- `app/(auth)/verify-email.tsx`
- `app/_layout.tsx`
- `src/api/AuthApi.ts`
- `src/api/httpClient.ts`
- `src/auth/AuthContext.tsx`
- `src/config/env.ts`
- `src/utils/authLinkRouting.ts`
- `src/utils/notificationRouting.ts`
- `scripts/test-auth-link-routing-contract.js`
- `app.json`
- `package.json`
- `.env.example`

Confirmed findings:

- Mobile uses Expo Router with an auth stack containing `login`, `signup`, `forgot-password`, `reset-password`, and `verify-email`.
- `app.json` has the custom scheme `threadlymobile`.
- Universal Links/App Links are not configured; `ios.associatedDomains` and Android intent filters are intentionally absent.
- Current mobile login renders email or username plus password together. It is not email-first and does not resolve sign-in methods after Continue.
- Current mobile login posts through `useAuth().signIn()` to `/auth/login`.
- Current mobile signup renders regular/brand account creation with first/last name, brand name, email, password, confirm password, and terms. It posts through `useAuth().signUp()` to `/auth/signup`.
- Mobile `AuthApi.ts` only exposes password reset request/confirm and verify email.
- Mobile `AuthContext` stores access/refresh tokens in SecureStore, sends refresh tokens to backend mobile flows, normalizes auth user responses, validates `/auth/profile`, and handles sign-in/sign-up/sign-out.
- Mobile login diagnostics mask passwords and summarize identifiers in development logs; raw passwords are not logged by the audited paths.
- Mobile has `expo-web-browser` and `expo-linking`, but it does not have `expo-auth-session`, `@react-native-google-signin/google-signin`, or Google client ID environment keys.
- Mobile environment config includes API base URL, web fallback URL, trusted web origins, credential mode, and storage keys. It does not include Google client IDs.
- Mobile auth-link routing maps reset-password and verify-email custom scheme/HTTPS paths only. It does not map email change, admin reset, staff invite, or Google auth callback paths.
- Mobile contract coverage exists for auth-link route handling. There is no Google auth, progressive-login, email-login-code, or password setup test coverage yet.

## Recommended Backend Data Model

Use an `AuthIdentity` table rather than adding `googleId` directly to `User`.

Reason: `AuthIdentity` keeps provider identity independent from account identity, supports future providers without schema churn, stores Google `sub` as the stable identity key, allows multiple identities per user, and avoids treating email as the provider identity.

Proposed provider model:

```prisma
enum AuthProvider {
  GOOGLE
}

model AuthIdentity {
  id              String       @id @default(uuid()) @db.Uuid
  userId          String       @db.Uuid
  user            User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  provider        AuthProvider
  providerSubject String
  email           String?
  emailVerified   Boolean      @default(false)

  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  @@unique([provider, providerSubject])
  @@index([userId])
  @@index([email])
}
```

Recommended additions:

- Add `authIdentities AuthIdentity[]` relation on `User`.
- Add an explicit local credential state. Preferred shape:

```prisma
enum LocalCredentialStatus {
  ENABLED
  NOT_SET
  DISABLED
}
```

- Add `localCredentialStatus LocalCredentialStatus @default(ENABLED)` to `User`, or create a dedicated `LocalCredential` table if the team accepts a larger auth refactor.
- Make `User.password` nullable in the migration if local credential state lives on `User`.

Evaluation of password representation options:

- Unusable password hash: not preferred as final design. It preserves the current non-null `User.password` shape but hides an account state in a fake credential. It can be used only as a temporary zero-downtime bridge if needed.
- Nullable password migration: recommended pragmatic path for this codebase if paired with `localCredentialStatus`. It makes Google-only users explicit and requires targeted guards in login, password reset, email change, account deletion, and password change.
- Local credential status field: recommended. It allows the backend and UI to distinguish password-enabled, Google-only, disabled, or future states without inferring from hash presence.
- Separate local credential table: cleanest long-term architecture. It removes password concerns from `User`, but it requires backfilling all current passwords and touching every password path. If schedule allows, name it `LocalCredential` with `userId`, `passwordHash`, `status`, `createdAt`, `updatedAt`, and `lastChangedAt`.

Recommended G2 choice: Add `AuthIdentity`, make `User.password` nullable, and add `localCredentialStatus`. This is smaller than a full credential-table extraction while still representing Google-only users safely and explicitly.

Recommended email-code/password-setup model:

```prisma
enum LoginCodePurpose {
  PASSWORD_SETUP
}

model EmailLoginCode {
  id          String           @id @default(uuid()) @db.Uuid
  userId      String           @db.Uuid
  user        User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  purpose     LoginCodePurpose
  codeHash    String
  expiresAt   DateTime
  usedAt      DateTime?
  attempts    Int              @default(0)
  createdAt   DateTime         @default(now())

  @@index([userId, purpose, expiresAt])
  @@index([codeHash])
}
```

Password setup should use a second short-lived hashed `PasswordSetupToken` or equivalent challenge row after code confirmation. Do not reuse normal password reset tokens unless the flow is explicitly treated as account recovery; this product flow is first-password creation after email ownership proof.

## Recommended Backend Endpoints

### `POST /auth/google`

Purpose:

- Authenticate a user with a backend-verified Google ID token.
- Create a new regular/brand account when no Threadly account exists.
- Link Google to an existing local account when the verified Google email matches.
- Return the same auth response shape as existing login/signup.

Payload:

```json
{
  "idToken": "google-id-token",
  "type": "REGULAR",
  "brandFullName": "Optional Brand Name"
}
```

Response:

- Existing `AuthTokensResponse` shape: `{ user, accessToken, refreshToken? }`.
- Include a clear message for account-created, linked, or signed-in states if needed.

Security rules:

- Verify ID token signature server-side.
- Validate issuer, expiry, and audience against allowed client IDs.
- Require `email_verified === true`.
- Use Google `sub` as `providerSubject`.
- Never trust profile data supplied outside the verified ID token.
- Do not store raw ID tokens.
- Do not expose Google client secret to web/mobile.
- Use a transaction when creating/linking `AuthIdentity` and `User`.
- If `AuthIdentity(provider=GOOGLE, sub)` exists, sign in that user.
- If identity does not exist and email matches an existing active Threadly user, link identity to that user only when Google email is verified.
- If identity does not exist and no user exists, create a user with `localCredentialStatus=NOT_SET` and no password.
- If email matches a suspended/deactivated account, do not create a duplicate; return a safe account-restricted response.

Rate limits:

- Similar to `/auth/login`, with separate per-IP and per-normalized-email throttles.

Account enumeration:

- Do not expose whether a matching local account exists before the Google token is verified.
- After verified Google identity, it is acceptable to return explicit user-facing states because the user proved control of the Google account.

Tests required:

- New Google signup creates `User` and `AuthIdentity`.
- Existing Google identity logs in.
- Existing password user links Google by verified email.
- Unverified Google email is rejected.
- Invalid audience/issuer/expired token is rejected.
- Suspended/deactivated matching account is not duplicated.
- Duplicate `providerSubject` is race-safe.
- Raw token is not stored or logged.

### `POST /auth/login-options`

Purpose:

- Support email-first progressive login after the user clicks Continue.
- Return enough method state for the UI to render password, Google, email-code/password-setup, or generic fallback states.

Payload:

```json
{
  "email": "user@example.com"
}
```

Response:

```json
{
  "requestId": "short-lived-resolution-id",
  "methods": {
    "password": true,
    "google": true,
    "passwordSetupAvailable": false
  },
  "message": "Continue with an available sign-in method."
}
```

Security rules:

- Normalize email server-side.
- Do not call this endpoint on every keystroke; call only after Continue.
- Do not reveal inactive/suspended account details.
- Use coarse response states and generic copy for unknown accounts.
- Consider returning the same HTTP status and top-level message for known/unknown accounts.
- Issue a short-lived `requestId` only if it helps tie later code requests to the resolved email.

Rate limits:

- Tight per-IP and per-email rate limit.
- Consider CAPTCHA or proof-of-work later if abuse appears.

Account enumeration considerations:

- This endpoint creates some enumeration pressure because the product requires different UI states after email Continue. Mitigation is not "zero enumeration"; mitigation is rate limiting, generic copy for unknown accounts, no keystroke calls, no inactive status disclosure, and not returning profile/user IDs.

Tests required:

- Password-only account returns password method.
- Google-only account returns Google plus password setup path.
- Google-linked password account returns both.
- Unknown email returns generic safe state.
- Suspended/deactivated account does not disclose detailed status.
- Endpoint is not used on every keystroke in web/mobile tests.

### `POST /auth/email-login-code/request`

Purpose:

- Send a one-time email code to a Google-only user who wants to create a local password.

Payload:

```json
{
  "email": "user@example.com",
  "purpose": "PASSWORD_SETUP",
  "requestId": "optional-login-options-request-id"
}
```

Response:

```json
{
  "message": "If this account can set up a password, a verification code has been sent."
}
```

Security rules:

- Generic response to prevent easy enumeration.
- Only send for active Google-only accounts with no local password.
- Generate a random numeric or alphanumeric code with enough entropy.
- Store only a hash of the code.
- Expire quickly, for example 10 minutes.
- Invalidate previous active setup codes for the same user/purpose.
- Track attempts and lock after a small number of failures.
- Do not store raw code or log raw code.

Rate limits:

- Per-IP, per-email, and per-user cooldown.

Tests required:

- Generic response for unknown emails.
- Code stored hashed.
- Previous active code invalidated.
- Expired code rejected.
- Too many attempts rejected.
- Raw code not logged.

### `POST /auth/email-login-code/confirm`

Purpose:

- Confirm email ownership with the one-time setup code.
- Return a short-lived password setup challenge token.

Payload:

```json
{
  "email": "user@example.com",
  "code": "123456",
  "purpose": "PASSWORD_SETUP"
}
```

Response:

```json
{
  "passwordSetupToken": "single-use-raw-token",
  "expiresInSeconds": 900
}
```

Security rules:

- Hash and compare code.
- Increment attempts on failure.
- Mark code used on success.
- Store only a hash of `passwordSetupToken`.
- Token must be single-use and short-lived.
- Do not issue an auth session.

Rate limits:

- Per-IP and per-code challenge.

Tests required:

- Valid code returns setup token.
- Invalid code increments attempts.
- Used code cannot be reused.
- Expired code is rejected.
- Returned setup token hash is stored; raw token is not stored.

### `POST /auth/password/setup`

Purpose:

- Let a Google-only user create their first local password after email-code verification.

Payload:

```json
{
  "passwordSetupToken": "single-use-raw-token",
  "newPassword": "new passphrase"
}
```

Response:

```json
{
  "message": "Password set successfully. Sign in with your new password."
}
```

Security rules:

- Treat as first-password creation, not normal reset-password.
- Validate the existing password policy.
- Require `localCredentialStatus=NOT_SET` or no local credential.
- Store Argon2id password hash.
- Set local credential status to `ENABLED`.
- Mark setup token used.
- Increment `authVersion` if the user has existing sessions.
- Revoke other refresh tokens if the user is not actively authenticated through the current flow.
- Do not auto-login after password setup from the email-first login flow.
- Send password-changed/security alert using the existing pattern.

Rate limits:

- Per-IP and per-setup-token.

Tests required:

- Password policy enforced.
- Setup token single-use.
- Google login remains linked.
- Email/password login works after setup.
- No automatic session is issued.
- Password-changed alert sent.

### Optional `POST /auth/google/link`

Purpose:

- Explicitly link a Google identity to the currently authenticated user.

Payload:

```json
{
  "idToken": "google-id-token"
}
```

Response:

```json
{
  "message": "Google sign-in linked."
}
```

Security rules:

- Require authenticated session.
- Verify Google token server-side.
- Require `email_verified=true`.
- If Google email differs from current account email, require a deliberate product decision before allowing.
- Enforce unique `(provider, providerSubject)`.

Rate limits:

- Per-user and per-IP.

Tests required:

- Authenticated user links verified matching Google email.
- Different email is rejected unless explicitly allowed later.
- Already-linked provider subject cannot be linked to another user.

## Progressive Login UX Plan

Use an email-first login flow.

Initial state:

- Email field only.
- Continue button.
- Continue with Google may be visible.
- Do not call the backend on every email keystroke.
- Resolve login method only after Continue.

After email method resolution:

- Password account: show password field.
- Google-only account: show Continue with Google and "verify email to create password".
- Google-linked password account: show password field and Google option.
- Unknown or generic state: avoid clear "no account exists" copy; use generic recovery/signup guidance.

Implementation warning:

- Because the UI changes based on email method state, the login-options endpoint can become an enumeration surface. The backend must rate limit, return generic copy, avoid inactive-status disclosure, avoid user IDs/profile data, and the clients must call only after Continue.

## Google-Only User Password Setup Flow

Recommended flow:

1. User enters email on login.
2. User clicks Continue.
3. Backend resolves the account as Google-only without a local password.
4. UI shows Continue with Google plus "verify email to create password".
5. User chooses password setup.
6. Backend sends an email code to the account email.
7. User enters the code.
8. Backend validates the hashed, expiring, single-use code.
9. Backend returns a short-lived password setup token.
10. User enters a new password and confirmation.
11. Backend validates the existing password policy.
12. Backend sets the local password and marks local credential status as enabled.
13. Existing Google identity remains linked.
14. User is sent back to login and must sign in with the new password or Google.

This is first-password creation, not normal reset-password. It can reuse password policy, password hashing, security alert, and session invalidation patterns, but it should not reuse reset-password copy or imply account recovery after compromise.

## Existing Password User Using Google

Recommended behavior:

- Frontend/mobile obtains a Google ID token through the chosen Google sign-in client.
- Backend verifies the token.
- Backend requires `email_verified=true`.
- Backend checks `AuthIdentity(provider=GOOGLE, providerSubject=sub)`.
- If identity exists, sign in that linked user.
- If identity does not exist, find existing Threadly user by normalized verified email.
- If active user exists, create the Google `AuthIdentity` linked to that user and sign in.
- If no user exists, create a new account with Google identity and no local password.
- If matching account is suspended/deactivated, do not create a duplicate and do not bypass account restrictions.

Duplicate prevention:

- Unique `User.email` prevents duplicate local accounts.
- Unique `(provider, providerSubject)` prevents duplicate Google identities.
- Linking by verified email prevents a second user row for an already registered email.

## Google Token Verification Rules

Backend must:

- Validate ID token signature.
- Validate `aud` against allowed client IDs.
- Validate issuer: `accounts.google.com` or `https://accounts.google.com`.
- Validate expiry and issued-at tolerance.
- Require `email_verified=true`.
- Normalize email for user lookup, but use `sub` as the provider identity.
- Store only provider, provider subject, email snapshot, and verification flag.
- Never trust frontend/mobile profile payloads by themselves.
- Never store raw Google ID tokens, access tokens, or refresh tokens unless a later product requirement explicitly needs Google API access.
- Never log raw ID tokens or provider tokens.

Recommended backend library:

- Use the official Google token verifier for Node, such as `google-auth-library`, in a backend-only service during G2. Do not add frontend/mobile token verification as the trust boundary.

## Required Environment Variables

Backend:

- `GOOGLE_ALLOWED_CLIENT_IDS`: comma-separated web/iOS/Android client IDs accepted as ID token audiences. Preferred when multiple clients exist.
- `GOOGLE_CLIENT_ID`: optional single-client fallback if only one client ID is used.
- `GOOGLE_CLIENT_SECRET`: backend-only and only needed if the backend uses OAuth code exchange. Not needed for ID-token-only verification.
- `APP_ENV`: existing environment marker.
- `WEB_APP_URL`: existing web URL used for email links and callbacks.

Frontend:

- `VITE_GOOGLE_CLIENT_ID`: public web OAuth client ID.
- `VITE_API_BASE_URL`: existing API base URL.

Mobile:

- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: public web client ID used by Expo auth flows when required.
- `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: public iOS client ID if native iOS flow is used.
- `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`: public Android client ID if native Android flow is used.
- `EXPO_PUBLIC_API_BASE_URL`: existing API base URL.

Rules:

- Google client IDs may be public.
- Google client secret must remain backend-only.
- Never commit real client secrets, OAuth JSON files, downloaded credential files, raw ID tokens, raw auth codes, or production `.env` files.
- Current backend `.env.example` must be cleaned before any Google auth commit that touches env examples.

## Web Screens Needed

Required web changes in later phases:

- Email-first login screen.
- Continue button that calls login-options only after click.
- Continue with Google button wired to Google Identity Services.
- Password state for local-password accounts.
- Google-only state with Continue with Google and verify-email-to-create-password action.
- Google-linked password state with both password and Google options.
- Email-code verification screen or inline login step.
- Password setup screen/state using the shared 12-character password policy and backend error handling.
- Loading, missing-code, invalid-code, expired-code, too-many-attempts, and success states.
- Account linking messaging for existing password users whose verified Google email matches.
- Signup flow entry for Google signup, including account type and brand name collection where needed.

Do not use current static Google/Apple buttons as proof of implementation; they are UI placeholders only.

## Mobile Screens Needed

Required mobile changes in later phases:

- Email-first login screen.
- Continue button that calls login-options only after tap.
- Google button wired to the chosen mobile Google auth package.
- Password state for local-password accounts.
- Google-only state with Continue with Google and verify-email-to-create-password action.
- Google-linked password state with both password and Google options.
- Email-code verification screen or step.
- Password setup screen/state using the 12-character policy.
- Loading, missing-code, invalid-code, expired-code, too-many-attempts, network-error, and success states.
- Account linking messaging for existing password users.
- Signup path for Google-created regular users and brand users.

Mobile package decision:

- Current app already has `expo-web-browser` and `expo-linking`.
- It does not have `expo-auth-session` or native Google Sign-In.
- Choose one later:
  - `expo-auth-session/providers/google` for Expo-managed OAuth with redirect handling.
  - `@react-native-google-signin/google-signin` if native Google Sign-In UX and config are required.

## Security Risks and Mitigations

Account enumeration:

- Risk: login-options can reveal method state.
- Mitigation: call only after Continue, rate limit, generic unknown/inactive states, no user IDs, no profile data, no status-specific inactive messages.

Duplicate account creation:

- Risk: Google signup creates a second user for an existing email.
- Mitigation: verify Google email, look up normalized `User.email`, link identity to existing active user in a transaction, keep `User.email` unique.

Unverified Google email:

- Risk: user controls a Google account without verified email.
- Mitigation: reject `email_verified=false`.

Token replay:

- Risk: stolen ID token reused during token lifetime.
- Mitigation: validate signature/audience/issuer/expiry, use HTTPS, short token lifetime from Google, do not store raw tokens, issue Threadly sessions only after server verification.

Leaked client secret:

- Risk: backend secret committed or exposed to clients.
- Mitigation: client secret lives only in backend secret manager/env; never in web/mobile env; clean current backend `.env.example` secret-like values before G2.

Code brute force:

- Risk: email-code setup code guessed.
- Mitigation: high-entropy code, hash storage, short expiry, attempts counter, per-IP/email throttles, invalidate after success.

Stale email-code tokens:

- Risk: old setup codes remain valid.
- Mitigation: invalidate previous active code on new request, expire quickly, mark used.

Login CSRF/state if OAuth code flow is used:

- Risk: callback code/state substitution.
- Mitigation: use PKCE/state/nonce if code flow is chosen. For ID-token client flow, validate nonce where available.

Mobile OAuth config mismatch:

- Risk: wrong client ID/audience causes sign-in failures or accepts wrong client.
- Mitigation: maintain `GOOGLE_ALLOWED_CLIENT_IDS`, test web/iOS/Android client IDs, document redirect URIs.

Raw token/code logging:

- Risk: tokens or codes appear in logs.
- Mitigation: add token/code redaction tests and logging helpers; continue current pattern of masked password diagnostics.

## Implementation Phases

- G1 Audit + architecture doc: current phase; documentation only.
- G2 Backend Google identity foundation: add provider data model, env placeholders, token verifier service, `POST /auth/google`, and backend tests.
- G3 Email-first login-options + email-code/password setup: add method-resolution endpoint, hashed setup code/token models, password setup endpoint, templates, and tests.
- G4 Web Google auth UI: add email-first login UX, Google web sign-in, code/password setup screens, and tests.
- G5 Mobile Google auth UI: add mobile Google auth package/config, email-first login UX, code/password setup screens, and tests.
- G6 QA/UAT and production readiness: environment verification, Google console client IDs/redirects, real-device mobile tests, security review, and release sign-off.

## Test Matrix

Backend:

- New Google signup creates user and identity.
- Existing Google identity logs in.
- Existing password user links Google by verified email.
- Google-only user direct email login does not show an empty password dead end.
- Login-options returns password state for password accounts.
- Login-options returns Google/password-setup state for Google-only accounts.
- Login-options avoids clear unknown-account enumeration.
- Email-code request returns generic response.
- Email-code stores only code hash.
- Email-code confirm rejects invalid, expired, reused, and over-attempt codes.
- Password setup validates policy.
- Password setup creates a local password and keeps Google identity linked.
- Duplicate email prevention works under race conditions.
- Unverified Google email is rejected.
- Invalid Google token is rejected.
- Wrong Google audience/client ID is rejected.
- Suspended/deactivated matching account does not sign in or duplicate.
- No client secret, raw token, or raw code appears in logs or committed files.
- Rate limits are enforced.
- No automatic password creation without user action.

Frontend:

- Login initial state shows email only and does not call backend on keystrokes.
- Continue calls login-options once.
- Password account renders password field.
- Google-only account renders Google option and password setup path.
- Google-linked password account renders both password and Google.
- Unknown/generic state avoids clear "no account" copy.
- Google button obtains an ID token and posts only token to backend.
- Email-code screen handles missing, loading, invalid, expired, and success states.
- Password setup uses shared 12-character policy.
- Signup UI supports Google account type/brand-name collection.
- No Google client secret is bundled.

Mobile:

- Login initial state shows email only and does not call backend on keystrokes.
- Continue calls login-options once after tap.
- Google auth package returns ID token for backend verification.
- Password, Google-only, and Google-linked states render correctly.
- Email-code screen handles missing, loading, invalid, expired, and success states.
- Password setup uses shared 12-character policy.
- Signup supports Google-created regular and brand users.
- Mobile client IDs are configured per platform.
- No Google client secret is bundled.

Cross-surface:

- Same Google-created user can log in on web and mobile.
- Password user can link Google on web and then log in with Google on mobile.
- Google-only user can create a local password on web and then use email/password on mobile.
- Google-only user can create a local password on mobile and then use email/password on web.
- Existing password reset still does not auto-login after reset.
- Email verification and auth-link flows remain compatible.

## Open Questions

- What are the exact Google web, iOS, and Android client IDs for QA/UAT and production?
- Will backend use ID-token verification only, or OAuth code exchange with backend client secret?
- Should G2 use nullable `User.password` plus `localCredentialStatus`, or invest immediately in a separate `LocalCredential` table?
- Which mobile Google package should be used: Expo AuthSession or native Google Sign-In?
- Should account linking by verified matching email be automatic, or should existing signed-in users explicitly confirm linking first?
- Can brand users sign up with Google immediately, or should Google signup launch for regular users first?
- For Google-created brand accounts, what minimum brand fields are required before creating the brand row?
- Should first-password setup from an already authenticated Google session preserve the current session or require re-login after `authVersion` increment?
- Should login-options include CAPTCHA/risk scoring in QA/UAT, or is rate limiting enough for launch?

## G2 Readiness Gate

It is safe to proceed to G2 backend implementation only after:

- The backend `.env.example` secret-like values are removed and any real exposed secret is rotated.
- Product confirms ID-token verification vs OAuth code exchange.
- Product confirms the local credential representation: nullable password plus status, or separate local credential table.
- Google client IDs for web/mobile are available for non-production testing.
- The team accepts that login-options cannot be completely enumeration-free if it changes UI state by account method; mitigations must be implemented and tested.
