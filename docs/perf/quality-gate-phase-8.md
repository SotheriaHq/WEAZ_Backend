# Phase 8 Backend Quality Gate

## Purpose

The backend quality gate keeps the private-media authorization, public URL, and explicit design media privacy protections running in CI and as a local pre-push command.

## CI Workflow

Workflow: `.github/workflows/phase8-quality-gate.yml`

Triggers:

- `pull_request`
- `push` to `main`

CI uses Node `22.12.0`, `npm ci`, and the npm lockfile cache. It does not use secrets, local database fixture seeds, production data, reset commands, or destructive Prisma commands.

## Required Checks

Run locally with:

```bash
npm run ci:phase8
```

The grouped command runs:

- `npm test -- src/upload/upload.service.spec.ts src/designs/mappers/design-response.mapper.spec.ts --runInBand`
- `npm run build`
- `npm run check:perf-regressions`

## What It Protects

- Public URL endpoint behavior for allowed public media.
- Denied public URL behavior for private media.
- Owner-gated signed URL behavior.
- Unauthorized signed URL denial.
- Production S3 signing path coverage.
- Non-production local disk signed display URL guards.
- Private explicit design response stripping of raw storage URLs and keys.
- Phase 5C fixture script production and non-local database guards.

## Manual Gates

`npm run seed:phase5c:private-media`, Prisma seed/reset scripts, and native runtime validation are intentionally excluded from CI. Private fixture creation remains local/dev only and must be invoked explicitly.

## Rollback

To remove this gate, revert the workflow file and the `ci:phase8` script. Keep the focused upload/design mapper tests and performance guard unless a later phase replaces them with equivalent coverage.
