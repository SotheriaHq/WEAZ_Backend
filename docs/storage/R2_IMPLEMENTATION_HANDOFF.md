# R2 implementation and release status

As a brand or shopper, I want one private R2 upload and delivery flow so that
my files cannot silently move to another storage provider.

## Current implementation

- R2-only startup validation; no AWS provider or credential fallback.
- Signed PUT uploads for designs, products and verification documents.
- No presigned POST policy or public bucket/CloudFront delivery path.
- Immutable staging promotion, actual content checks, current parent access,
  owned processing and durable reference-aware object deletion.
- Web/native use explicit PUT contracts and reject retired AWS media URLs.
- Web headers permit the verified R2 account and authenticated Worker, without
  AWS/CloudFront wildcards.
- Image quality and antivirus remain separate work items; antivirus is deferred.

## Verified evidence

The deployed SIT Worker passes all nine live checks, including SVG rejection
with HTTP 415, signed PNG delivery, HEAD/ranges/conditions, expiry/tampering, CORS and
private-origin denial. Temporary probe objects were deleted and absence checked.
See [gateway evidence](evidence/r2-sit-gateway-smoke.json).

Focused R2-only backend tests pass 87 checks and backend typechecking passes.
The exclusive-provider real application probe passed nine scenarios on 29 October,
generated 12 variants and cleaned all 32 objects. It exercised the actual upload
HTTP/JWT controller and processing worker with disposable PostgreSQL and isolated
Redis. It does not replace browser/device acceptance.

## Release boundary

SIT switched to the exclusive R2 backend release `8a6f336` through GitHub deployment
`40851472678` on 29 October. Runtime configuration resolves the private
`wiez-sit-media` bucket and authenticated gateway in `sit`; retired AWS storage
configuration names are absent. API liveness and database/Redis/worker readiness
passed. All 162 migrations are applied with no failures or pending migrations;
reference seeds and both existing users were preserved. No database reset was run.
The live website returns R2/gateway CSP entries and no AWS/CloudFront policy.

Local normal migrations and reseeding also passed without replacing the admin.
Native APK and interactive browser/device regression remain separate release gates.
For subsequent cutovers, drain writers before dependency/schema replacement, retain
private backups and apply migrations through the normal deployment pipeline.

Private evidence and draft previews require current API authorization. The
optional gateway must never expose private files or unsigned bucket access.
See [provider configuration](provider-config.md), [Worker setup](SIT_MEDIA_GATEWAY_SETUP.md)
and [upload security audit](UPLOAD_SECURITY_AUDIT.md).
