# R2 storage and authenticated media delivery

R2 is the sole object store. There is no AWS S3 provider, IAM credential chain,
public bucket, CDN alias or presigned POST fallback. Missing R2 settings fail
startup. `STORAGE_PROVIDER` may be omitted or set to `R2`; any other value fails.

| Setting | Requirement |
| --- | --- |
| `R2_BUCKET` | Private R2 bucket, 3–63 valid characters |
| `R2_ACCOUNT_ID` / `R2_ENDPOINT` | Valid matching account ID or HTTPS R2 account API origin |
| `R2_ACCESS_KEY_ID` | Dedicated R2 object access key |
| `R2_SECRET_ACCESS_KEY` | Dedicated R2 object access secret |
| Region | Always `auto` |

Unrelated service credentials cannot substitute for R2 credentials. Retired
AWS bucket/endpoint settings and public-base aliases are rejected, even when
an alias happens to equal the Worker URL. All R2 objects remain private.
Uploads use signed PUT capabilities with server-authorized keys and exact
content headers. Finalization verifies stored size, content and ownership.
The SDK uses the S3-compatible protocol supported by R2; its package/command
names do not enable AWS S3 storage.

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
| `MEDIA_GATEWAY_TTL_SECONDS` | API token lifetime; 60–900 seconds, default 300 |

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

The 60-second minimum keeps valid configurations above the shared clients’
30-second renewal margin and prevents repeated immediate renewal requests.

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

Shared web/native loaders now recognize gateway and R2 SDK expiry, batch exact
source renewals, and fence cache results by account session. The focused web
suite passed 38 tests; native resolver/policy and structural-sharing contracts
passed. These are local checks, not deployed browser/device evidence.

**Activation gate:** API result caches can live longer than five minutes. A short-lived gateway URL must not be activated merely because
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

For the exact SIT Worker name, private bucket binding, dashboard variables and
deployment authorization, see [SIT media gateway setup](SIT_MEDIA_GATEWAY_SETUP.md).
