# Google Auth QA/UAT Checklist

## Purpose

This checklist is the G4 release-readiness gate for Threadly Google auth. It verifies that Google signup/login, progressive email-first login, Google-only first-password setup, existing account linking, and security boundaries are ready for QA/UAT and production review.

User story: As a Threadly user, I want to sign up or log in with Google and be guided correctly if I have a Google-only account, password account, or linked account, so that I can access Threadly without confusion or duplicate accounts.

## Scope

In scope:

- Backend Google ID-token verification and Google identity storage.
- Web Google Identity Services login/signup.
- Mobile Expo AuthSession login/signup.
- Email-first login-options behavior.
- Google-only email-code first-password setup.
- Existing password account linking through verified matching Google email.
- Duplicate account prevention.
- Security and environment readiness.

Out of scope:

- Apple auth.
- Universal Links or App Links.
- Login/signup redesign.
- Automatic login after password reset.
- Automatic login after Google-only password setup.
- Frontend/mobile Google client secret usage.

## Required Environments

Local developer:

- Backend API: `http://localhost:3040` or the local backend port in use.
- Web app: `http://localhost:3000` or the actual Vite/preview port in use.
- Mobile physical device: must use LAN IPs, not `localhost`, for API and web links.
- Google OAuth clients may use test users while the consent screen is in testing mode.

QA/UAT:

- Web: `https://qa.<domain>`.
- API: `https://qa-api.<domain>`.
- Mobile: QA/dev-client build configured with QA API and public Google client IDs.
- Database: QA/UAT database with the G2 migration applied.

Production:

- Web: `https://<production-web-domain>`.
- API: `https://<production-api-domain>`.
- Mobile: signed production build configured through deployment secrets.
- Database: production database migrated through the approved release process.

## Required Secrets And Env Values

Use placeholders in documentation and committed examples only. Real values belong in deployment secret storage or ignored local `.env` files.

Backend:

```env
GOOGLE_ALLOWED_CLIENT_IDS=<google-web-client-id>,<google-ios-client-id>,<google-android-client-id>
GOOGLE_CLIENT_ID=<google-web-client-id>
GOOGLE_CLIENT_SECRET=<google-client-secret-if-code-exchange-is-used>
APP_ENV=<qa-or-production>
WEB_APP_URL=https://qa.<domain>
DATABASE_URL=<qa-database-url>
```

Notes:

- `GOOGLE_ALLOWED_CLIENT_IDS` must include every Google client ID that can produce an ID token accepted by Threadly.
- The current backend code reads `GOOGLE_ALLOWED_CLIENT_IDS` and optional fallback `GOOGLE_CLIENT_ID`. It does not read `GOOGLE_ALLOWED_CLIENT_ID`.
- `GOOGLE_CLIENT_SECRET` is backend-only and only needed if the backend later uses OAuth code exchange. The current G2/G3 implementation is ID-token verification only.
- `GOOGLE_ALLOWED_CLIENT_SECRET` is not a recognized backend key in the current implementation.
- Never put `GOOGLE_CLIENT_SECRET` in frontend or mobile code, env examples, tests, or docs.

Frontend:

```env
VITE_GOOGLE_CLIENT_ID=<google-web-client-id>
VITE_API_BASE_URL=https://qa-api.<domain>
VITE_APP_URL=https://qa.<domain>
```

Mobile:

```env
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<google-web-client-id>
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<google-ios-client-id>
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=<google-android-client-id>
EXPO_PUBLIC_API_BASE_URL=https://qa-api.<domain>
EXPO_PUBLIC_WEB_APP_URL=https://qa.<domain>
```

Local G4 env check on 2026-05-17:

| Surface | Local value status |
| --- | --- |
| Backend `WEB_APP_URL` | Present in ignored `.env` |
| Backend `DATABASE_URL` | Present in ignored `.env` |
| Backend `APP_ENV` | Missing in ignored `.env` |
| Backend `GOOGLE_ALLOWED_CLIENT_ID` | Present in ignored `.env`, but not read by current backend code |
| Backend `GOOGLE_ALLOWED_CLIENT_IDS` | Missing in ignored `.env`; this is the required allowed-audiences key |
| Backend `GOOGLE_ALLOWED_CLIENT_SECRET` | Present in ignored `.env`, but not read by current ID-token verification code |
| Backend `GOOGLE_CLIENT_ID` | Missing in ignored `.env` |
| Web `VITE_API_BASE_URL` | Present in ignored `.env` |
| Web `VITE_APP_URL` | Missing in ignored `.env` |
| Web `VITE_GOOGLE_CLIENT_ID` | Missing in ignored `.env` |
| Mobile `.env` | Missing locally |

## Backend Migration Checklist

- [ ] Confirm migration file exists: `prisma/migrations/20260517100000_add_google_auth_foundation/migration.sql`.
- [ ] Confirm migration adds `AuthProvider`, `PasswordCredentialStatus`, and `LoginCodePurpose`.
- [ ] Confirm migration makes `User.password` nullable and adds `User.passwordCredentialStatus`.
- [ ] Confirm migration adds `AuthIdentity`, `EmailLoginCode`, and `PasswordSetupToken`.
- [ ] Run `npx prisma validate`.
- [ ] Run `npx prisma generate`.
- [ ] Apply migration to QA/UAT database through the approved migration process.
- [ ] Verify existing password users still authenticate after migration.
- [ ] Verify backup/rollback plan exists before production migration.

## Web Google Console Setup Checklist

- [ ] Create or identify the OAuth web client ID.
- [ ] Add local JavaScript origin, for example `http://localhost:3000` or the actual local web port.
- [ ] Add QA/UAT JavaScript origin: `https://qa.<domain>`.
- [ ] Add production JavaScript origin: `https://<production-web-domain>`.
- [ ] Add authorized redirect URIs only if the selected web flow requires them.
- [ ] Confirm OAuth consent screen status and test users for QA.
- [ ] Confirm domain verification requirements for production.
- [ ] Add the web client ID to backend `GOOGLE_ALLOWED_CLIENT_IDS`.

## Mobile Google Console Setup Checklist

- [ ] Create or identify Android client ID if Android native/dev-client testing is used.
- [ ] Create or identify iOS client ID if iOS testing is used.
- [ ] Confirm whether Expo AuthSession requires the web client ID for the tested flow.
- [ ] Configure Android package name.
- [ ] Configure iOS bundle identifier.
- [ ] Add Android SHA-1 and SHA-256 fingerprints where required by Google.
- [ ] Confirm Expo AuthSession redirect URI for Expo Go/dev-client and QA builds.
- [ ] Add every mobile client ID that can produce an ID token to backend `GOOGLE_ALLOWED_CLIENT_IDS`.

## Backend Google Console Setup Checklist

- [ ] `GOOGLE_ALLOWED_CLIENT_IDS` includes the web client ID.
- [ ] `GOOGLE_ALLOWED_CLIENT_IDS` includes the iOS client ID if iOS produces ID tokens.
- [ ] `GOOGLE_ALLOWED_CLIENT_IDS` includes the Android client ID if Android produces ID tokens.
- [ ] `GOOGLE_ALLOWED_CLIENT_IDS` includes any Expo/web client ID used by AuthSession.
- [ ] `GOOGLE_CLIENT_SECRET` is not configured unless OAuth code exchange is intentionally added later.
- [ ] Backend logs are reviewed for raw ID token/code/secret leakage.

## Web QA Matrix

| Case | Expected result | G4 status |
| --- | --- | --- |
| Login starts email-first | Email field is shown first; password is hidden | Automated test passed |
| Continue behavior | `/auth/login-options` called only after Continue | Automated test passed |
| Password account | Password state renders | Automated test passed |
| Google-only account | Google action and create-password path render | Automated test passed |
| Google-linked account | Password and Google options render | Needs real QA |
| Unknown/generic state | Avoids clear account enumeration | Needs real QA |
| Existing Google-created login | Google login succeeds | Blocked by missing local Google client ID |
| Google regular signup | New regular account created | Blocked by missing local Google client ID |
| Google brand signup | Brand name required before signup | Needs real QA |
| Terms/privacy gate | Required before Google signup | Needs real QA |
| Existing password user links Google | Verified matching Google email links and signs in | Needs real QA |
| Email-code request | Generic code-sent response | Automated path covered; real email QA pending |
| Email-code confirmation | Returns setup token | Automated path covered; real email QA pending |
| Password setup | Creates local password without session | Automated test passed |
| Password setup success | Does not auto-login; user returns to login | Automated test passed |
| Invalid/expired code | Clear error | Needs real QA |
| Google cancellation | Safe error | Needs real QA |
| Missing client ID | Safe misconfiguration state | Implementation present; manual QA pending |
| Browser bundle | No Google client secret | Secret scan passed except guardrail regex matches |

## Mobile QA Matrix

| Case | Expected result | G4 status |
| --- | --- | --- |
| Login starts email-first | Email field is shown first; password is hidden | Contract/type checks passed |
| Continue behavior | `/auth/login-options` called only after tap | Contract check passed |
| Password account | Password state renders | Contract check passed |
| Google-only account | Google action and create-password path render | Contract check passed |
| Google-linked account | Password and Google options render | Needs real device QA |
| Unknown/generic state | Avoids clear account enumeration | Needs real device QA |
| Existing Google-created login | Google login succeeds | Blocked by missing mobile env/client IDs |
| Google regular signup | New regular account created | Blocked by missing mobile env/client IDs |
| Google brand signup | Brand name required before signup | Needs real device QA |
| Terms/privacy gate | Required before Google signup | Needs real device QA |
| Existing password user links Google | Verified matching Google email links and signs in | Needs real device QA |
| Email-code request | Generic code-sent response | Contract path present; real email QA pending |
| Email-code confirmation | Returns setup token | Contract path present; real email QA pending |
| Password setup | Creates local password without session | Contract path present; real email QA pending |
| Password setup success | Does not auto-login; user returns to login | Contract path present; real device QA pending |
| Invalid/expired code | Clear error | Needs real device QA |
| Google cancellation | Safe error | Needs real device QA |
| Missing client IDs | Safe misconfiguration state | Implementation present; manual QA pending |
| Expo AuthSession redirect | Returns to app | Needs Expo Go/dev-client QA |
| Mobile bundle/source | No Google client secret | Secret scan passed except guardrail regex matches |

## Backend QA Matrix

| Case | Expected result | G4 status |
| --- | --- | --- |
| Prisma schema validates | Valid schema | Passed |
| Prisma client generates | Client generation succeeds | Passed |
| Existing password login | Still works | Automated Google foundation coverage plus manual QA pending |
| Existing password reset | Still works and does not auto-login | Automated hardening tests passed |
| Existing password change | Still works and increments authVersion | Automated hardening tests passed |
| Existing email verification | Still works | Needs real QA |
| Auth-link routing | Remains intact | Existing contract/docs; real QA pending |
| Invalid Google token | Rejected | Automated test passed |
| Wrong audience | Rejected | Automated test passed |
| Unverified Google email | Rejected | Automated test passed |
| New Google signup | Creates `User` and `AuthIdentity` | Automated test passed; real Google QA pending |
| Existing Google identity login | Works | Needs real Google QA |
| Existing password user verified-email link | Links and signs in | Automated test passed; real Google QA pending |
| Suspended/deactivated match | Rejected; no duplicate | Automated test passed |
| Google-only account state | `password=null`, `passwordCredentialStatus=NOT_SET` | Automated test passed |
| Google-only direct email login | Returns setup-required state without user id | Automated test passed |
| Password account login-options | Returns password state | Automated test passed |
| Google-only login-options | Returns Google/setup state | Automated test passed |
| Unknown/restricted login-options | Safe generic response | Needs real/manual API QA |
| Email-code request | Generic response | Automated test passed |
| Email-code storage | Hash only, no raw code | Automated test passed |
| Email-code expiry | Expired code rejected | Automated coverage required before production if not already covered by focused tests |
| Email-code single-use | Used code rejected | Automated coverage required before production if not already covered by focused tests |
| Password setup token single-use | Used token rejected | Automated coverage required before production if not already covered by focused tests |
| Password setup policy | Enforced | Automated test passed |
| Password setup session behavior | No auth tokens issued | Automated test passed |
| Password setup authVersion/session handling | Revokes sessions/increments authVersion by design | Automated test passed |
| Logs | No raw Google token, setup code, or client secret | Source/tests reviewed; production log QA pending |

## Cross-Surface QA Matrix

| Case | Expected result | G4 status |
| --- | --- | --- |
| Web-created Google account logs in on mobile | Same account usable on both surfaces | Not completed |
| Mobile-created Google account logs in on web | Same account usable on both surfaces | Not completed |
| Web-created setup password works on mobile | Email/password login works on mobile | Not completed |
| Mobile-created setup password works on web | Email/password login works on web | Not completed |
| Web-linked Google account works on mobile | Google provider identity is shared | Not completed |
| Mobile-linked Google account works on web | Google provider identity is shared | Not completed |
| Same verified email | Does not create duplicate users | Automated backend coverage; cross-surface manual pending |
| Same provider subject | Cannot attach to two users | Schema unique constraint present; manual pending |
| Password reset vs first-password setup | Remain separate flows | Automated and implementation audit passed |
| Auth-link flows | Remain usable after Google auth changes | Existing auth-link checks passed in prior phases; real QA pending |

## Security QA Matrix

| Case | Expected result | G4 status |
| --- | --- | --- |
| No real Google secret/client ID committed | No real-looking values in committed source/docs/examples | Passed |
| No frontend/mobile client secret | Secret only backend-only if ever used | Passed |
| Invalid ID token | Backend rejects | Passed |
| Wrong audience | Backend rejects | Passed |
| Unverified email | Backend rejects | Passed |
| Raw ID token logs | No raw ID token in source/log patterns | Source review passed; production log QA pending |
| Raw email setup code logs | No raw code in source/log patterns | Source review passed; production log QA pending |
| Code hash storage | Only hash stored | Automated test passed |
| Setup token hash storage | Only hash stored | Automated test passed |
| Unknown email-code request | Generic response | Automated test passed |
| Login-options rate limiting | Must be protected or explicitly risk-accepted | Release blocker until confirmed |
| Email-code endpoint rate limiting | Must be protected or explicitly risk-accepted | Release blocker until confirmed |
| Suspended/deactivated users | Not duplicated or allowed through Google | Automated test passed |
| Password setup auto-login | Must not issue session | Automated test passed |
| Password reset auto-login | Must not issue session | Automated hardening tests passed |

## Automated Checks Run On 2026-05-17

Backend:

- `npx prisma validate` - passed.
- `npx prisma generate` - passed.
- `npx jest src/auth/auth-google-foundation.spec.ts src/auth/helper/google-token-verifier.service.spec.ts src/auth/auth-password-reset-hardening.spec.ts --runInBand` - passed, 19 tests.
- `npx tsc --noEmit --pretty false` - passed.
- `npm run build` - passed.
- `git diff --check` - passed.

Frontend:

- `npm test -- LoginPage.googleAuth --run` - passed, 5 tests.
- `npm run test:auth-link-route-contract` - passed.
- `npm run build` - passed with existing large-chunk warning.
- Secret scan for Google secret/client-secret patterns - no committed secret found; only the contract script's guardrail regex matched.
- `git diff --check` - passed.

Mobile:

- `npm run test:auth-link-routing-contract` - passed.
- `npm exec tsc -- --noEmit` - passed.
- `npm run audit:design-system` - passed, 72/188 findings baseline.
- Secret scan for Google secret/client-secret patterns - no committed secret found; only the contract script's guardrail regex matched.
- `git diff --check` - passed with one CRLF warning in unrelated pre-existing feed diff.

## Release Blockers

- QA/UAT backend `GOOGLE_ALLOWED_CLIENT_IDS` is not confirmed configured.
- Local backend `.env` currently uses `GOOGLE_ALLOWED_CLIENT_ID` instead of the backend-read `GOOGLE_ALLOWED_CLIENT_IDS`; Google QA will fail until the key name is corrected.
- Local backend `.env` currently has `GOOGLE_ALLOWED_CLIENT_SECRET`, which is not read by the current ID-token verification implementation.
- QA/UAT backend `APP_ENV`, `WEB_APP_URL`, and `DATABASE_URL` must be confirmed in deployment secrets.
- QA/UAT frontend `VITE_GOOGLE_CLIENT_ID`, `VITE_API_BASE_URL`, and `VITE_APP_URL` must be confirmed in deployment secrets.
- QA/UAT mobile `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_API_BASE_URL`, and `EXPO_PUBLIC_WEB_APP_URL` must be confirmed in the build environment.
- G2 migration must be applied to QA/UAT before real auth QA.
- Real Google web signup/login was not tested in this local pass.
- Real Google mobile signup/login was not tested in this local pass.
- Expo AuthSession redirect behavior was not tested in a real dev client or device.
- Existing password user Google linking was not tested with a real verified Google account.
- Google-only email-code password setup was not tested end-to-end with real email delivery.
- Unknown/restricted login-options enumeration behavior still needs real API QA.
- Rate limiting/throttling for `login-options` and email-code endpoints must be confirmed before production.
- The previously exposed secret-like Google value documented in G1/G2 must be rotated if it was real.
- App Links/Universal Links are not implemented and must not be claimed as supported.

## Sign-Off Checklist

- [ ] Backend migration applied in QA/UAT.
- [ ] Real Google web client ID configured in web and backend allowed audiences.
- [ ] Real mobile Google client IDs configured in mobile build and backend allowed audiences.
- [ ] Web Google regular signup passes.
- [ ] Web Google brand signup passes.
- [ ] Mobile Google regular signup passes.
- [ ] Mobile Google brand signup passes.
- [ ] Existing password user can link/login with Google by verified matching email.
- [ ] Google-only user can request code, confirm code, create password, and then explicitly sign in.
- [ ] Google-only user can still log in with Google after creating a password.
- [ ] Suspended/deactivated matching account is rejected and not duplicated.
- [ ] Invalid/wrong-audience/unverified Google tokens are rejected.
- [ ] No raw Google ID tokens, setup codes, setup tokens, or client secrets appear in logs.
- [ ] Product owner signs off on brand-user Google signup scope.
- [ ] Engineering signs off on rate limiting and production secret configuration.

## Known Limitations

- This G4 pass completed implementation audit and automated regression checks only. Real Google-account QA was blocked by missing local Google client IDs and no mobile `.env`.
- Mobile production readiness depends on real Expo AuthSession redirect testing in Expo Go/dev-client or the intended QA build.
- The current implementation intentionally uses ID-token verification only. Backend OAuth code exchange and backend Google client secret handling are not implemented.
- Google client IDs are public, but exact real values must not be committed.
- Apple auth remains out of scope.
- Universal Links/App Links remain out of scope.

## Production Readiness Status

Status: `READY_FOR_QA_UAT_AUTOMATED_GATE_PASSED`, `PRODUCTION_BLOCKED_PENDING_REAL_GOOGLE_QA`.

The codebase is ready for QA/UAT configuration and real-account testing. It is not production-ready until the release blockers above are closed.
