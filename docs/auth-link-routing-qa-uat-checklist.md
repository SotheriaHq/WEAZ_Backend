# Auth Link Routing QA/UAT Checklist

## 1. Purpose

This checklist verifies Threadly auth email links across backend, web, and mobile before release. The goal is to confirm that password reset, email verification, and account-security links keep a reliable HTTPS web fallback while mobile custom-scheme reset handling is ready for QA/UAT.

## 2. Scope

In scope:
- Backend auth-link URL generation and password-reset security behavior.
- Web forgot-password, reset-password, verify-email, and account-security email-change handling.
- Mobile forgot-password messaging, custom-scheme reset-password routing, and native reset-password screen states.
- Environment variable readiness for local, QA/UAT, and production.

Out of scope:
- Google auth and Apple auth.
- Automatic login after password reset.
- Production iOS Universal Links or Android App Links until real domains and association files exist.
- New backend auth-link routes.

## 3. Environments

Local/test:
- Backend API: `http://localhost:3040`
- Web app: `http://localhost:<web-port>` such as `http://localhost:3000` or the repo's active dev port.
- Mobile emulator: may use emulator host aliases such as `10.0.2.2` for Android.
- Physical mobile device: must use a LAN IP, not `localhost`.

QA/UAT:
- Web app placeholder: `https://qa.<domain>`
- API placeholder: `https://qa-api.<domain>`
- Mobile build env values must point to QA/UAT hosts.

Production:
- Web app placeholder: `https://<production-web-domain>`
- API placeholder: `https://<production-api-domain>`
- Production Universal/App Links must not be claimed until platform association files and app config are present.

## 4. Required Env Variables

Backend:

```env
APP_ENV=development
WEB_APP_URL=http://localhost:<web-port>
FRONTEND_URL=http://localhost:<web-port>
WEB_APP_USE_HTTPS=false
WEB_APP_HOST=localhost
WEB_APP_PORT=<web-port>
FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL=http://localhost:<web-port>/bag/payment-return
```

QA/UAT backend example:

```env
APP_ENV=qa
WEB_APP_URL=https://qa.<domain>
FRONTEND_URL=https://qa.<domain>
WEB_APP_USE_HTTPS=true
WEB_APP_HOST=qa.<domain>
WEB_APP_PORT=443
FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL=https://qa.<domain>/bag/payment-return
```

Production backend example:

```env
APP_ENV=production
WEB_APP_URL=https://<production-web-domain>
FRONTEND_URL=https://<production-web-domain>
WEB_APP_USE_HTTPS=true
WEB_APP_HOST=<production-web-domain>
WEB_APP_PORT=443
FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL=https://<production-web-domain>/bag/payment-return
```

Frontend:

```env
VITE_API_BASE_URL=http://localhost:3040
VITE_APP_URL=http://localhost:<web-port>
VITE_API_WITH_CREDENTIALS=true
```

QA/UAT frontend example:

```env
VITE_API_BASE_URL=https://qa-api.<domain>
VITE_APP_URL=https://qa.<domain>
VITE_API_WITH_CREDENTIALS=true
```

Production frontend example:

```env
VITE_API_BASE_URL=https://<production-api-domain>
VITE_APP_URL=https://<production-web-domain>
VITE_API_WITH_CREDENTIALS=true
```

Mobile:

```env
EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:3040
EXPO_PUBLIC_WEB_APP_URL=http://192.168.x.x:<web-port>
EXPO_PUBLIC_TRUSTED_WEB_ORIGINS=http://192.168.x.x:<web-port>
EXPO_PUBLIC_API_WITH_CREDENTIALS=true
```

QA/UAT mobile example:

```env
EXPO_PUBLIC_API_BASE_URL=https://qa-api.<domain>
EXPO_PUBLIC_WEB_APP_URL=https://qa.<domain>
EXPO_PUBLIC_TRUSTED_WEB_ORIGINS=https://qa.<domain>
EXPO_PUBLIC_API_WITH_CREDENTIALS=true
```

Production mobile example:

```env
EXPO_PUBLIC_API_BASE_URL=https://<production-api-domain>
EXPO_PUBLIC_WEB_APP_URL=https://<production-web-domain>
EXPO_PUBLIC_TRUSTED_WEB_ORIGINS=https://<production-web-domain>
EXPO_PUBLIC_API_WITH_CREDENTIALS=true
```

## 5. Local/Test Setup

- Start the backend API with local env values.
- Start the web app on the selected local port.
- Set backend `WEB_APP_URL` to the actual web origin used for email links.
- Set frontend `VITE_API_BASE_URL` to the local API origin.
- For a physical mobile device, set mobile API and web origins to a LAN IP such as `http://192.168.1.50:3040` and `http://192.168.1.50:3000`.
- Do not use `localhost` for physical mobile-device API or web fallback testing.
- For mobile custom-scheme testing, use `threadlymobile://reset-password?token=TEST_TOKEN` in a dev client or native build.

## 6. QA/UAT Setup

- Backend `WEB_APP_URL` must be `https://qa.<domain>`.
- Frontend `VITE_APP_URL` must be `https://qa.<domain>`.
- Frontend `VITE_API_BASE_URL` must be `https://qa-api.<domain>`.
- Mobile `EXPO_PUBLIC_WEB_APP_URL` must be `https://qa.<domain>`.
- Mobile `EXPO_PUBLIC_API_BASE_URL` must be `https://qa-api.<domain>`.
- Send real QA/UAT reset and verification emails through the configured email provider.
- Confirm the email HTML and plaintext links both use the QA/UAT web host.

## 7. Production Setup Placeholders

- Backend API: `https://<production-api-domain>`
- Web app: `https://<production-web-domain>`
- Backend auth email links: `WEB_APP_URL=https://<production-web-domain>`
- Frontend API calls: `VITE_API_BASE_URL=https://<production-api-domain>`
- Mobile API calls: `EXPO_PUBLIC_API_BASE_URL=https://<production-api-domain>`
- Mobile web fallback: `EXPO_PUBLIC_WEB_APP_URL=https://<production-web-domain>`
- Universal/App Links: deferred until production domains, AASA, Digital Asset Links, and app config are all complete.

## 8. Web Test Matrix

| Flow | Expected result | Status |
| --- | --- | --- |
| Open `/forgot-password` as guest | Page loads without auth and returns a generic check-inbox response. | [ ] |
| Submit forgot-password for known account | User sees generic response; email is sent if allowed. | [ ] |
| Submit forgot-password for unknown account | User sees the same generic response. | [ ] |
| Open `/reset-password?token=<token>` | Reset form appears; token is not displayed. | [ ] |
| Open `/reset-password` | Missing-token state appears. | [ ] |
| Submit short or mismatched passwords | Submission is blocked or backend validation error is shown. | [ ] |
| Submit valid reset token and password | Success state appears and URL becomes `/reset-password` without token. | [ ] |
| Confirm no auto-login after reset | User must go to login and sign in with the new password. | [ ] |
| Reuse consumed reset token | Invalid or expired token error appears. | [ ] |
| Open expired or invalid reset token | Clear invalid/expired error appears. | [ ] |
| Open `/verify-email?token=<token>` | Verification works without requiring prior auth route. | [ ] |
| Open `/verify-email` | Missing-token state appears. | [ ] |
| Process `emailChangeToken` in account security | Token is trimmed, processed, and removed from URL history. | [ ] |

## 9. Mobile Test Matrix

| Flow | Expected result | Status |
| --- | --- | --- |
| Open forgot-password screen | Screen loads in auth stack. | [ ] |
| Submit forgot-password email | Success copy says the secure link can open on device or browser. | [ ] |
| Open `threadlymobile://reset-password?token=TEST_TOKEN` | Native reset-password screen opens. | [ ] |
| Open `threadlymobile:///reset-password?token=TEST_TOKEN` | Native reset-password screen opens. | [ ] |
| Open `threadlymobile://reset-password` | Missing-token state appears. | [ ] |
| Enter mismatched passwords | Submission is blocked and mismatch state is shown. | [ ] |
| Enter password under 12 characters | Submission is blocked and length validation is shown. | [ ] |
| Submit valid real reset token | Success state appears; user returns to login only by explicit action. | [ ] |
| Confirm no raw token logging | Token is never printed in app logs. | [ ] |
| Confirm no auto-login after reset | Auth context remains unauthenticated until user signs in. | [ ] |

## 10. Backend Test Matrix

| Flow | Expected result | Status |
| --- | --- | --- |
| Password reset link generation | Uses `WEB_APP_URL` and `/reset-password?token=...`. | [ ] |
| Admin reset link generation | Uses `WEB_APP_URL` and `/admin/reset-password?token=...`. | [ ] |
| Email verification link generation | Uses `WEB_APP_URL` and `/verify-email?token=...`. | [ ] |
| Email-change link generation | Remains `/settings?tab=account-security&emailChangeToken=...`. | [ ] |
| Reset token storage | Token is stored hashed, not raw. | [ ] |
| Reset token expiry | Expired tokens are rejected. | [ ] |
| Reset token single use | Consumed token cannot be reused. | [ ] |
| Repeated reset requests | Old active tokens are invalidated and suppression is preserved. | [ ] |
| Successful reset | Refresh tokens are revoked and `authVersion` increments. | [ ] |
| Authenticated password change | `authVersion` increments and current-session behavior remains as designed. | [ ] |
| Unknown/inactive reset logs | Logs do not expose raw email addresses. | [ ] |

## 11. Cross-Device Test Matrix

| Flow | Expected result | Status |
| --- | --- | --- |
| Email HTTPS reset link on desktop | Opens web fallback and completes reset. | [ ] |
| Email HTTPS reset link on mobile browser | Opens web fallback and completes reset. | [ ] |
| App not installed | HTTPS web fallback still works. | [ ] |
| App/dev client installed | Custom scheme opens native reset screen. | [ ] |
| Real reset email opened on physical device | User can complete reset without being sent to an app store. | [ ] |
| Real verification email opened on desktop/mobile web | User can complete verification on web fallback. | [ ] |
| Password reset complete | User is not automatically logged in and must sign in with the new password. | [ ] |

## 12. Release Blockers

- QA/UAT `WEB_APP_URL` not configured.
- QA/UAT `VITE_API_BASE_URL` not configured.
- QA/UAT `VITE_APP_URL` not configured.
- QA/UAT `EXPO_PUBLIC_API_BASE_URL` not configured for mobile build.
- QA/UAT `EXPO_PUBLIC_WEB_APP_URL` not configured for mobile build.
- Real reset email not tested end-to-end.
- Real email verification not tested end-to-end.
- Password reset token reuse not tested.
- Expired/invalid token behavior not tested.
- Mobile custom scheme not tested on a real device or dev client.
- App Links/Universal Links not configured but claimed as supported.

## 13. Known Limitations

- Backend-generated auth email links remain HTTPS web links by design.
- Mobile supports custom-scheme reset links, not production Universal/App Links.
- Native mobile email verification is not implemented.
- Native mobile email-change confirmation is not implemented.
- Native mobile admin reset is not implemented.
- App-store redirects before password reset completion are not supported.
- The canonical local web port remains an environment decision; use the actual active web dev port.

## 14. Sign-Off Checklist

- [ ] Backend auth-link tests passed in QA/UAT branch.
- [ ] Backend Prisma validation passed.
- [ ] Backend build passed or environment limitation documented.
- [ ] Frontend reset-password tests passed.
- [ ] Frontend build passed.
- [ ] Mobile auth-link routing contract passed.
- [ ] Mobile TypeScript check passed.
- [ ] Mobile design-system audit passed or limitation documented.
- [ ] Real QA/UAT password reset email tested end-to-end.
- [ ] Real QA/UAT email verification email tested end-to-end.
- [ ] Real physical-device custom-scheme reset flow tested.
- [ ] Product owner confirms no automatic login after password reset.
- [ ] Product owner confirms Universal/App Links are not claimed for this release.
