# Final Routing, Data, and Media Hardening

Date: 2026-05-23

This document is the release-readiness reference for the backend side of the Threadly routing, data, and media performance hardening work from Phase 0 through Phase 8.

## Original Problem

Client runtime traces proved repeated profile/detail/media requests and signed URL churn. Backend inspection found media variants and public URL helpers already existed, but public media delivery was not consistently variant/display-first for every client path. Private-media success validation was originally blocked because no active local test user owned a valid private READY fixture.

## Final Backend State

- Public media delivery prefers stable public display URLs before falling back to signing raw storage keys.
- Private media remains owner-gated through the signed URL endpoint.
- Explicit private design media responses strip raw storage URLs, storage keys, and private variant URLs so clients must use the signed fallback path.
- Production S3 presigning remains intact.
- Non-production local disk signed display URLs exist only for local/dev validation and are guarded away from production.
- A local/dev-only Phase 5C private media fixture script exists, requires an explicit flag, and refuses production or non-localhost database URLs.

## Request-Budget And Privacy Policy

Backend release policy:

- Public media may return stable public display URLs when allowed.
- Private media public URL lookup must deny or return no usable public URL.
- Owner signed URL lookup may succeed for authorized private media.
- Unauthorized signed URL lookup must fail cleanly.
- Explicit private design responses must not expose raw `s3Url`, `s3Key`, `url`, or private variant raw URLs.
- Private fixture scripts must never run automatically in CI.
- No destructive seed/reset command should be part of the performance quality gate.

## Media Policy

Public media priority:

1. Stable public variant/display URL where available.
2. Stable public original/display URL where available.
3. Public URL endpoint response when the file is public.
4. Owner-gated signed URL only for private or unavailable public access.

Private media rules:

- Private signed URLs remain owner-gated by file ownership.
- Unauthorized users must not receive private signed URLs.
- Signed URL secrets, tokens, cookies, request bodies, and response bodies must not be logged.
- Production signed media must stay on the S3 presigned URL path.
- Local disk display URL support is non-production validation support only.

## Fixture Policy

Manual fixture command:

```bash
THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE=1 npm run seed:phase5c:private-media
```

Rollback:

```bash
THREADLY_PHASE5C_PRIVATE_MEDIA_FIXTURE=1 npm run seed:phase5c:private-media -- --rollback
```

Fixture safety rules:

- Run only against a local/dev database.
- Never run in production.
- Never invoke from CI.
- Never commit local DB IDs beyond the documented deterministic local fixture values.
- Use it only to validate owner signed fallback, unauthorized denial, and private response stripping.

## CI Quality Gate

Workflow: `.github/workflows/phase8-quality-gate.yml`

Local command:

```bash
npm run ci:phase8
```

The backend gate runs:

- `npm test -- src/upload/upload.service.spec.ts src/designs/mappers/design-response.mapper.spec.ts --runInBand`
- `npm run build`
- `npm run check:perf-regressions`

The gate protects public URL behavior, private public-URL denial, owner-gated signed URLs, unauthorized signed URL denial, production S3 signing, non-production local disk guardrails, private explicit design response stripping, and fixture script safety.

CI intentionally excludes fixture seeds, Prisma reset/seed commands, local database setup, destructive commands, native runtime validation, and secrets.

## Manual Private Media Validation Checklist

Prerequisites:

- Local/dev database.
- Backend running with a safe local `DATABASE_URL`.
- Phase 5C fixture created explicitly.
- Owner and unauthorized user sessions available.

Owner checks:

- Public URL lookup for private fixture denies or returns no usable public URL.
- Signed URL lookup succeeds for the owner.
- Media displays through signed fallback.
- Signed URL secret is not printed.
- Signed URL 400 spam stays 0.

Unauthorized checks:

- Same private route/API access is denied.
- Signed URL endpoint does not leak media.
- Client fails cleanly without a request loop.

## Rollback Plan

- CI rollback: revert `.github/workflows/phase8-quality-gate.yml` and the `ci:phase8` script only if the gate itself is broken.
- Fixture rollback: run the fixture rollback command above on local/dev only.
- Backend media rollback: preserve owner gating and private response stripping while reverting any public-display-url changes.
- Guard rollback: remove `npm run check:perf-regressions` from CI only for an urgent hotfix, then restore equivalent coverage before release.

Minimum rollback checks:

```bash
npm run ci:phase8
git diff --check
```

## Deferred Work

- Native Android/iOS AppState/background-resume runtime validation remains a mobile manual release gate.
- Optional CI expansion to full authenticated E2E once stable auth and media fixtures exist.
- No compressor or worker rewrite is part of this hardening release.
