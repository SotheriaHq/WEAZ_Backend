# Phase 5C Private Signed-Media Fixture

Date: 2026-05-23

## Status

Phase 5C created a local/dev-only private media fixture and validated the owner-gated signed-media path.

The fixture is explicitly guarded and must not be used against production:

- `THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE=1` is required.
- `NODE_ENV=production` is rejected.
- `DATABASE_URL` must point to a localhost database.
- The helper is explicit; it is not part of normal seed execution.

## Fixture

Command:

```powershell
$env:THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE='1'
$env:NODE_ENV='development'
$env:APP_PUBLIC_URL='http://localhost:3040'
npm run seed:phase5c:private-media
```

Created or reused:

- Owner: `brand@example.com`
- Unauthorized test user: `phase5c.unauthorized@threadly.test`
- Private file id: `5c5c0000-0000-4000-8000-000000000105`
- Private design id: `5c5c0000-0000-4000-8000-000000000104`
- Route: `/designs/5c5c0000-0000-4000-8000-000000000104`

Rollback:

```powershell
$env:THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE='1'
npm run seed:phase5c:private-media -- --rollback
```

## Backend Behavior

The owner-gated signed endpoint now supports local development disk-upload URLs without changing production S3 behavior.

- Production still uses AWS S3 presigned URLs.
- Non-production local URLs are allowed only when the stored URL points to a private/local network host and an `/uploads/` path.
- The signed endpoint remains owner-gated by `fileUpload.userId`.
- Private explicit design responses omit direct storage URLs and raw storage keys so clients must resolve private media through the signed fallback path.

## Validation Result

Direct endpoint validation against the local backend:

| Check | Result |
| --- | ---: |
| Private file public URL lookup | 400 |
| Owner signed URL lookup | 200 |
| Unauthorized signed URL lookup | 400 |
| Public media public URL lookup | 200 |
| Signed URL 400 spam | 0 |
| Cache-busted/no-store calls | 0 |

No signed URL secrets, tokens, cookies, Authorization headers, request bodies, or response bodies were logged.

## Test Coverage

Focused backend tests cover:

- Non-production local disk upload display URL for owner-gated signed media validation.
- Production path still using S3 presigning.
- Explicit private design media response sanitization.

