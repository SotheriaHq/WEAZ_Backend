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
The earlier real application probe passed nine scenarios, generated 12 variants
and cleaned 32 objects; rerun it for the exclusive-provider release before
claiming current full application acceptance.

## Release boundary

The last read-only SIT inspection still found the older backend release using
AWS S3. Worker readiness is not application cutover. Do not mark this complete
until the exclusive-provider changes pass CI, the backend environment contains
R2 settings with retired storage keys removed, and the deployed upload, image
processing, delivery, renewal and deletion flows are verified. Drain API/worker
writes before environment/schema changes. Preserve the two current accounts;
do not repeat the database reset. Apply pending migrations through deployment.

Private evidence and draft previews require current API authorization. The
optional gateway must never expose private files or unsigned bucket access.
See [provider configuration](provider-config.md), [Worker setup](SIT_MEDIA_GATEWAY_SETUP.md)
and [upload security audit](UPLOAD_SECURITY_AUDIT.md).
