# R2 integration handoff

Date: 2026-10-22. Status: reviewed implementation inputs, **not an active or
deployed R2 migration**. Implementation ownership has moved to the designated
R2 implementation owner. This handoff authorizes implementation work only; it
does not authorize a production cutover, live storage migration, source deletion
or exposure of private bucket contents.

## What is available

These independently testable files are supplied for integration:

| File | Purpose |
| --- | --- |
| `src/upload/storage-provider.config.ts` | Pure provider validation, metadata URL identity, optional gateway signing |
| `src/upload/storage-provider.config.spec.ts` | 45 passing provider/security configuration tests |
| `infrastructure/media-gateway/worker.mjs` | Optional authenticated Worker over a private R2 binding |
| `infrastructure/media-gateway/worker.test.cjs` | 14 passing signer-to-Worker HTTP/security tests |
| `infrastructure/media-gateway/wrangler.example.toml` | Illustrative, non-deployable route/bucket template |
| `infrastructure/media-gateway/.gitignore` | Excludes deployment secrets and local deployment state |
| `docs/storage/provider-config.md` | Configuration, security boundaries, activation gates and verification commands |

No web/native media-expiry or refresh files were changed for this handoff.
No bucket, credentials, DNS route, Worker or application environment was deployed.
The locally passing tests use deterministic storage/cache stubs, not real R2.
They do not establish deployed authorization, CORS, object parity or capacity.

## Export contract

```ts
resolveStorageProviderSettings(config: StorageConfigReader): StorageProviderSettings
signPublicGatewayUrl(gateway, key, method = 'GET', nowMs = Date.now()): string
encodeMediaObjectKey(key: string): string
isRawStorageUrl(settings: StorageProviderSettings | undefined, value: string): boolean
storageObjectUrl(settings: StorageProviderSettings, key: string): string
```

`StorageConfigReader` exposes the Nest ConfigService-compatible generic
`get<T>(key: string): T | undefined`. Settings contain:

```ts
{
  provider: 'S3' | 'R2';
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  publicGateway?: { baseUrl: string; secret: string; environment: string; ttlSeconds: number };
}
```

The default preserves S3/IAM behavior. R2 selection is explicit and never falls
back to an AWS bucket, credential pair or region. The optional gateway uses
`MEDIA_GATEWAY_BASE_URL`, `MEDIA_GATEWAY_SECRET`,
`MEDIA_GATEWAY_ENVIRONMENT` and `MEDIA_GATEWAY_TTL_SECONDS`. It is absent when
those settings are absent. The default gateway token lifetime is 300 seconds,
with a maximum of 900. `storageObjectUrl` is a metadata identity, not a display
URL. The signing function is not an authorization function.

## Required server integration boundaries

1. Resolve provider settings once at startup and construct the storage client
   from them. Preserve S3 behavior while preparing R2. R2 requires its account
   API endpoint, `auto` region, bucket and R2 credential pair. Validate SDK
   checksum settings against current provider support rather than assuming all
   AWS options are interchangeable.
2. Preserve current image quality settings, per-file processing leases,
   attempt-specific object keys and fenced atomic variant publication. Integrate
   incremental encoding into those safeguards; replacing the worker with the
   older Alpha implementation would remove them.
3. Keep all R2 objects private. Mint gateway URLs only after checking the source
   file's publication/visibility eligibility. Private verification, order,
   draft and moderation previews require authorized SDK signed GETs.
4. Separate anonymous-public and caller-authorized variant resolution.
   `getBatchVariantDisplayUrls` previously passed `isPublic: true` without its
   own visibility check, and moderation previews call this helper. That call
   chain cannot itself prove a file is publicly eligible.
5. `getPublicSignedUrlByKey` must authorize the parent file and sign the requested
   active variant key. Its existing fallback selected the parent original key,
   which loses the selected thumbnail/card variant. SDK signatures must stay on
   the API origin; a gateway URL needs its own signature.
6. Remove raw-provider URL fallbacks from response serializers. Review
   `UploadService.getPublicDisplayUrl`, `getStablePublicDisplayUrl`,
   `getFileVariants`, `StoreService` media fallback, brand banner fallback and
   canonical profile DTO hydration. A non-AWS hostname is not proof of public
   access: R2 API URLs are also private provider URLs.

## Legacy references and URL-only clients

`MarketSectionService` matches product/brand URL strings against
`FileUpload.s3Url`. Updating only that column breaks the mapping while
`Product.images` and `Brand.logo` retain their previous strings. Preserve aliases
until all dependent references are migrated, or batch-resolve trusted legacy
origins to canonical keys/file IDs. Keep canonical user-profile precedence and
hydrate delivery URLs below that shared identity source.

The current Market fallback parser recognizes AWS only and removes the first
path segment even for virtual-hosted S3 URLs. Centralize origin-aware parsing;
do not guess which path segment is a bucket. No source URL should be fetched
server-side, and no extracted key should be signed without file/entity access
checks.

Images without a file ID need an authorized way to renew their exact source
variant. A client cannot safely infer a gateway route prefix or a path-style
R2 bucket prefix. One compatible option is to accept an alternate full-source
`url` parameter on the existing public/authenticated key-signing routes, resolve
only configured trusted origins server-side, then apply the existing file and
active-variant authorization. Retain existing `key` requests. This alternate
source contract has **not** been implemented in this handoff.

## Client expiry and cache gaps that block gateway activation

The actual shared native loaders are `src/hooks/useResolvedImageUri.ts`,
`components/ui/StableImage.tsx` and
`src/components/media/AspectAwareMedia.tsx`. The web loaders include
`src/hooks/useSignedFileUrl.ts` and `src/components/ImageWithFallback.tsx`.
Their API cache helpers live in each app's `src/api/BrandApi.ts`, and both
apps mirror signed-URL structural sharing in `src/query/structuralSharing.ts`.

Verified gaps requiring implementation and regression tests:

- Web/native expiry detection recognizes AWS-style fields but does not recognize
  this gateway's `exp`/`sig` claims. Storage-host classification also needs R2 API
  origins rather than an AWS-only substring check.
- Web session URL caches use a 14-minute lifetime. That can exceed a five-minute
  gateway token lifetime. Bound every cache entry by the URL's actual expiry,
  with a refresh margin, including restored query data and API caches.
- Native direct URLs can return before the `forceRefresh` branch. Direct URLs
  without a file ID also skip scheduled renewal. A failed/expired source must
  reach an authorized renewal path rather than returning the same URL.
- Web hook-based images do not currently schedule renewal for a payload URL
  that was usable at mount. Browser focus/visibility and native AppState resume
  need expiry checks, including timers paused while the app is backgrounded.
- URL-only error fallbacks can retry the same expired string. Use a file ID or
  the verified source-resolution contract, preserving the selected variant.
  Allow one bounded error-triggered renewal rather than an infinite retry loop.
- Unsigned private storage URLs must not be rendered as a last-resort fallback.
  Legitimate external media URLs should keep their existing direct behavior.
- Session cleanup clears several caches, but an old in-flight request can finish
  after a clear. Fence cache writes/results by the authenticated session
  generation, and clear image-loader last-good/in-flight caches on account
  change. Private URLs must not survive into another account's cache.
- When adding gateway support to structural sharing, do not preserve an expired
  URL or compare only its path while discarding the signed environment, method
  or other content-selection parameters. Keep equivalent behavior across apps
  with an executable contract test.

The established SDK display URL lifetime must not be shortened implicitly
while these gaps remain. Keep the gateway disabled until shared loaders and
raw-URL image/video consumers pass idle, restored-cache, foreground/resume and
expired-link recovery checks on every supported surface.

## Finalization and future video work

A signed PUT URL may be reused until it expires. Upload into a staging key;
after authorized validation, acquire a renewable intent lease and promote the
observed bytes to an attempt-specific immutable key. A conditional single
`CopyObject` can bind that promotion to the observed source ETag. Run storage
operations outside database transactions. Publish the file and mark the intent
USED together in a transaction that checks the current lease token.

Finalization retries must return the same completed file, including retries
after the original presign has expired. Persist processing delivery/outbox state
and destination attempt identities so crashes cannot strand untracked objects.
Failed/uncommitted objects require durable, reference-aware cleanup. HEAD MIME
metadata is not proof of the bytes' actual type; keep content validation and
decompression limits.

R2 supports conditional `CopyObject`, but its documented `UploadPartCopy` does
not support the same source conditions. Do not extend the single-object
promotion guarantee to multipart videos without a separate correctness design.
Object storage and ranged GET support do not implement transcoding, codec and
duration validation, thumbnails, resumable upload state or playback recovery.

## Worker behavior and retraction

The Worker validates HMAC, audience, environment, method, canonical path and
expiry before every cache lookup. GET tokens also allow HEAD; HEAD-only tokens
cannot read a body. It streams image/video content, handles single byte ranges,
ETag/date preconditions and read-only CORS without credentialed cookies.

An already issued token remains a bearer capability until expiry. The design
provides a bounded 300-second default retraction window, not immediate per-object
revocation. Responses already authorized may finish streaming after expiry;
already delivered bytes cannot be retracted. Immediate revocation requires a
checked revocation/publication-version mechanism or object removal plus purge.

Verify the actual hostname invokes this Worker. A direct public bucket custom
domain or enabled `r2.dev` URL bypasses it entirely. A configured gateway URL
and secret do not prove those alternate paths are disabled.

## Local evidence and remaining gates

Verified locally on the supplied files:

```text
node node_modules/jest/bin/jest.js src/upload/storage-provider.config.spec.ts --runInBand
45 tests passed

node --test infrastructure/media-gateway/worker.test.cjs
14 tests passed
```

The gateway tests exercise the actual Node signer against the actual Worker,
including UTF-8 keys, warm-cache denial, expiry, environment/audience tampering,
GET/HEAD permissions, ranges, validators, CORS and storage failures. They use
stubs for the R2 binding and cache. Configuration tests do not prove the app has
been wired to the resolver.

Required before R2 activation: complete server/client integration; run the
combined application checks; verify real SIT signed uploads, finalization and
object promotion; test private access and gateway bypass denial; prove client
renewal after idle; measure actual worker memory/latency and request operations;
produce resumable copy manifests, checksum/reference parity, deletion tombstone
and delta reconciliation results; rehearse recovery including R2-only writes;
obtain approval for the specific production cutover. None is implied by the
local test counts above.

## Primary references checked

- [R2 authentication, endpoints and jurisdictions](https://developers.cloudflare.com/r2/api/tokens/)
- [R2 S3 API support, including CopyObject and UploadPartCopy conditions](https://developers.cloudflare.com/r2/api/s3/api/)
- [Signed operations and API-domain restrictions; form POST is unsupported](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Private bindings, conditional reads and ranged reads](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Public custom domains and alternate public URL bypass](https://developers.cloudflare.com/r2/buckets/public-buckets/)
