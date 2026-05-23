# Phase 6 Regression Hardening

Phase 6 adds a backend regression guard for the media authorization and fixture protections proven in Phase 5C.

## Guard Command

```bash
npm run check:perf-regressions
```

The guard checks:

- public delivery keeps stable display URL preference before signing
- private public-URL denial and production S3 presigning tests remain present
- local/dev signed display URL support remains guarded away from production
- explicit design private media still strips direct `s3Key`, `s3Url`, `url`, and variant raw URLs
- the Phase 5C private media fixture script requires an explicit flag
- the fixture script refuses production
- the fixture script refuses non-localhost database URLs
- the fixture script does not hardcode remote S3/private media URLs

## Media Policy

- Public media may return stable display URLs where allowed.
- Private media must remain owner-gated through signed URL fallback.
- Explicit private design media responses must not expose raw storage URLs or keys.
- The local/dev fixture exists only to validate the signed fallback path against a localhost database.

## Native Gate

Backend media validation is complete for local/dev fixture behavior. Native mobile runtime validation remains a separate manual gate because the current machine has no Android/iOS runtime tooling.

## Rollback

The scanner is isolated to `scripts/check-perf-regressions.cjs` and the package script. It does not change backend runtime behavior.
