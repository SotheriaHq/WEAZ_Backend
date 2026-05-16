# Email Verification URL Routing Report

## Summary

Clarified local/test email verification URL behavior and added focused tests for backend web-app URL resolution. Desktop local verification links should use `http://localhost:3000`; LAN IP links remain supported for mobile-device testing when intentionally configured.

## Files Changed

- `.env.example`
- `src/common/utils/web-app-url.spec.ts`
- `docs/email-verification-url-routing-report.md`

Local ignored file updated on this machine:
- `.env` now uses `WEB_APP_URL=http://localhost:3000`

## Audit Findings

Verification link generation:
- `EmailVerificationHelperService.generateVerificationLink()` calls `resolveWebAppBaseUrl()`.
- Signup and resend verification flows both call `generateVerificationLink()`.
- The frontend verification route is `/verify-email`.

Base URL precedence:
1. `WEB_APP_URL`
2. `FRONTEND_URL`
3. Local fallback built from `WEB_APP_USE_HTTPS`, `WEB_APP_HOST`, and `WEB_APP_PORT`

Non-local behavior:
- If `APP_ENV`, `DEPLOY_ENV`, or `NODE_ENV` is `qa`, `uat`, `staging`, `production`, or `prod`, the backend throws unless `WEB_APP_URL` or `FRONTEND_URL` is configured.

Observed broken link:
- The backend local `.env` contained `WEB_APP_URL=http://192.168.110.91:3000`.
- That exact variable produced the timed-out desktop link.

## Root Cause

The backend generated the LAN IP link because local `.env` explicitly configured `WEB_APP_URL=http://192.168.110.91:3000`. That is valid for mobile-device testing only when the frontend dev server is bound to `0.0.0.0` and the test device can reach that IP. For desktop browser testing, it should be `http://localhost:3000`.

## Fixes Applied

- Updated `.env.example` to default local web URLs to `http://localhost:3000`.
- Added comments explaining desktop local testing versus mobile-device LAN testing.
- Added tests covering:
  - `WEB_APP_URL` wins.
  - `FRONTEND_URL` fallback works.
  - local fallback defaults to `http://localhost:3000`.
  - `WEB_APP_HOST` / `WEB_APP_PORT` can intentionally produce a LAN IP.
  - local HTTPS fallback is opt-in.
  - non-local environments throw without configured frontend URL.
- Updated the ignored local backend `.env` to `WEB_APP_URL=http://localhost:3000` for current desktop QA.

## Local Testing Guidance

Desktop local:

```env
WEB_APP_URL=http://localhost:3000
```

Then restart the backend and resend the verification email. New links should open as:

```txt
http://localhost:3000/verify-email?token=...
```

Mobile-device local:

```env
WEB_APP_URL=http://<LAN-IP>:3000
```

Use this only if the frontend dev server is bound to `0.0.0.0`, the firewall allows access, and the device can reach that IP.

Production/staging:

```env
WEB_APP_URL=https://your-real-web-domain.example
```

## Validation

- `npx prisma validate` passed.
- `npx prisma generate --schema prisma/schema.prisma` passed.
- `npm run build` passed.
- `npx jest src/common/utils/web-app-url.spec.ts --runInBand` passed.
- `git diff --check` passed with line-ending warnings only.

## Known Limitations

- The backend cannot know whether a configured LAN IP is reachable from the user opening the email. That remains an environment setup responsibility.

## Out of Scope Confirmation

Feed scoring, feed rendering, recommendations, interaction events, market/feed redesign, and taxonomy refactors were not changed.
