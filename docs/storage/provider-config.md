# Storage provider and authenticated public-media delivery

The default remains S3. Selecting R2 is explicit and requires R2-specific
credentials, bucket and account API endpoint. This implementation does not
deploy a Worker, create buckets, copy historical objects or switch an environment.

## Provider configuration

| Setting | S3 | R2 |
| --- | --- | --- |
| `STORAGE_PROVIDER` | `S3`, also the default when no R2 settings exist | Must explicitly be `R2` |
| Bucket | `AWS_S3_BUCKET`, then `S3_BUCKET` | `R2_BUCKET` |
| Region | `AWS_REGION`, then `REGION`, then `eu-north-1` | Always `auto` |
| Endpoint | Optional HTTPS `S3_ENDPOINT` | `R2_ENDPOINT`, or derived from `R2_ACCOUNT_ID` |
| Credentials | Explicit AWS/legacy pair, or the SDK IAM chain | `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are mandatory |
| Path style | Enabled for an explicit endpoint | Enabled |

S3 supports the legacy `ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` pair and preserves an
explicit `AWS_SESSION_TOKEN`. Partial explicit credentials fail startup.
Explicit `STORAGE_PROVIDER=S3` allows preparing unused R2 settings without changing
the active provider. R2 settings with an unspecified provider fail rather than
silently continuing to write to S3.

R2 never inherits an AWS bucket, region or credentials. Unrelated AWS settings
may remain for services such as SES. R2 endpoints must be HTTPS account API
origins; the default and the `eu`, `us` and `fedramp` jurisdiction forms are
recognized. A configured account ID must match the endpoint. Buckets in a
jurisdiction require its corresponding endpoint and Worker binding configuration.
[Cloudflare authentication and jurisdiction endpoints](https://developers.cloudflare.com/r2/api/tokens/)

All R2 objects remain private. Public-bucket flags are rejected. Legacy
`MEDIA_PUBLIC_BASE_URL`, `CDN_PUBLIC_BASE_URL`, `CLOUDFRONT_PUBLIC_BASE_URL`,
`CLOUDFRONT_URL`, `S3_PUBLIC_BASE_URL` and `R2_PUBLIC_BASE_URL` must be absent or
exactly match an explicitly configured authenticated gateway. A URL called a
gateway in configuration is not proof that the deployed hostname is protected;
the activation checks below must verify the actual route.

`storageObjectUrl` produces a metadata identity URL, never an authorized display
URL. SDK signatures must remain on the R2 API hostname; do not rewrite a signed
SDK URL onto a custom hostname. Private evidence and owner/order previews use
authorized SDK signed GETs. Public-eligible files may use the optional gateway
only after the API has checked publication, visibility and file eligibility.
[Cloudflare presigned URL domain restrictions](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

## Optional Worker gateway

The gateway is disabled when its settings are absent. The API must have all of:

| Setting | Meaning |
| --- | --- |
| `MEDIA_GATEWAY_BASE_URL` | HTTPS Worker origin, optionally with a plain route prefix |
| `MEDIA_GATEWAY_SECRET` | Shared randomly generated signing secret, at least 32 UTF-8 bytes |
| `MEDIA_GATEWAY_ENVIRONMENT` | Explicit lowercase environment identifier such as `sit` |
| `MEDIA_GATEWAY_TTL_SECONDS` | API token lifetime; default 300 seconds, maximum 900 |

The Worker receives the same base URL, environment and secret. Configure its
`MEDIA_BUCKET` binding to the private bucket; `MEDIA_GATEWAY_MAX_TTL_SECONDS`
defaults to 900 and may be reduced. Its optional `MEDIA_GATEWAY_ALLOWED_ORIGINS`
is a comma-separated exact browser-origin allowlist, or `*` for public fashion
media; cookies and credentialed CORS are never enabled. Its cache version may
be changed with `MEDIA_GATEWAY_CACHE_VERSION` when changing the binding or cache
policy. Keep SIT and production buckets, routes and signing secrets separate.

Use `infrastructure/media-gateway/wrangler.example.toml` as a non-deployable
template. Copy it to an ignored `wrangler.toml`, replace the illustrative route
and bucket, and provision the signing secret through the deployment secret
store. Never place it in the template, commit history, request logs or analytics.
The template disables `workers.dev`; a production deployment must serve the
configured custom Worker route.

The URL signature binds its protocol version, GET/HEAD permission, origin,
canonical encoded path, exact object key, environment and expiration. A GET
token also permits HEAD; a HEAD token cannot fetch a body. Claims are checked
before every edge-cache lookup. Expired, altered, cross-environment or ambiguous
URLs cannot retrieve cached bodies. The Worker streams media and supports HEAD,
single byte ranges, ETag/date preconditions and bounded read-only CORS preflight.
It does not provide video transcoding or multipart upload orchestration.

Do not enable a direct public bucket custom domain or `r2.dev` URL. They bypass
the Worker completely. Storage being private by default does not prove these
alternate routes are disabled; inspect and test the deployed bucket settings.
[Cloudflare public-bucket bypass guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/)

## Retraction and client-cache contract

An issued URL is a bearer capability. With the API default, a newly withdrawn
post can remain readable through an already issued token for up to 300 seconds
(900 if that lifetime was selected). API and Worker clocks must be synchronized.
The Worker validates expiry before cache reads, and browser cache lifetime is
capped at the token's remaining lifetime. Already delivered bytes cannot be
retracted, and a response authorized before expiry may finish streaming later.
This design does not claim immediate per-object revocation. Immediate revocation
requires a checked revocation/publication-version mechanism or object removal
plus any necessary CDN purge.

**Activation gate:** existing clients cache API results and URLs longer than
five minutes. A short-lived gateway URL must not be activated merely because
its signature tests pass. Verify every native/web image and video surface after
idle, query-cache restoration and app/browser resume, including components that
render raw URLs. They must recognize `exp`/`sig`, discard expired URLs, obtain a
new authorized URL without changing variant selection, and recover from an
expired-link error without retry loops. Keep the optional gateway disabled until
these checks pass. This configuration does not change the established SDK URL
lifetime for deployments without the gateway.

## Verification

Local checks use the actual Node signer and Worker with deterministic storage
and cache stubs; they require no bucket or credentials:

```text
node node_modules/jest/bin/jest.js src/upload/storage-provider.config.spec.ts --runInBand
node --test infrastructure/media-gateway/worker.test.cjs
```

Before activation, verify against real SIT R2: signed PUT/GET and finalization;
conditional object promotion; Unicode keys; CORS from each web origin; Worker
route and binding; valid GET/HEAD/range/conditional requests; expired and
tampered requests against a warm cache; token refresh after client idle; drafts,
verification evidence and private order files denied at the gateway; unsigned
custom-domain access denied; `r2.dev` access disabled; environment separation;
clock synchronization; cold/warm latency, operation counts and peak memory.
No real R2, DNS, bucket-policy or deployed-Worker result is implied by local tests.
