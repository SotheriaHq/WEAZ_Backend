# Upload security audit — 27 October 2026

As a shopper or brand, I want uploaded media and documents checked and isolated
so that another user's upload cannot execute application code or expose my files.

## Controls implemented

| Boundary | Enforcement |
| --- | --- |
| Original filename | Plain metadata only; 255-byte limit; reject paths, control/bidirectional characters, encoded path/null separators and executable double extensions. Accents, spaces and ordinary version dots remain supported. |
| File type | Per-purpose extension and MIME allowlists must agree; inspect actual stored signature under the observed ETag. HTML, SVG, executable and arbitrary archive uploads are not accepted. |
| Image content | Read only the byte-capped image, require actual type agreement, decode all pixels before publication; reject corrupt/truncated data, unsupported raster formats and excessive dimensions/animation. No lossy rewrite is introduced by validation. |
| Resource limits | Configured byte limits cannot exceed endpoint ceilings. Multipart files, fields, field bytes and parts are bounded. Image processing has a 50-million-total-pixel, 200-frame and 10-second operation budget. Upload-controller request throttling also covers authenticated mutations. |
| Object naming | Server-generated UUID/attempt-specific staging and final keys; client filenames never become paths. Conditional immutable promotion prevents reusable PUT capabilities from overwriting committed media. |
| Storage and execution | R2 is a private object store outside the application web root. Upload routes use memory buffers, not executable disk directories. Neither the API nor the Worker executes uploaded files. The gateway permits only supported image/video MIME types and applies `nosniff` and sandboxed CSP headers. |
| Access | Actual JWT and current-parent authorization; document, verification and message uploads never become anonymous files merely because a public flag is set. Private variants retain parent authorization and exact selected object identity. |
| Failure recovery | Intent before external write, owner-fenced finalization, durable orphan deletion and reference-aware cleanup. Invalid bytes never become a committed file. |

These controls preserve image quality settings and the existing supported
document formats. A file signature is not an antivirus verdict. Document and
video signature checks do not certify their entire contents as harmless.
Antivirus scanning is explicitly deferred by the product owner to a separate
work item after the existing implementation list; it is not silently simulated.

R2 signed PUTs remain bearer capabilities until expiry. Finalization enforces
actual size and type; it is not an ingress storage quota or a guarantee against
repeated staging writes during that capability's lifetime. No unverified
storage-capacity or malware-free claim is made.

## Verification

- `src/upload/upload-policy.spec.ts`, `src/upload/upload.service.spec.ts` and
  `src/media-processing/media-processing.service.spec.ts`: 69 tests pass.
- `node --test scripts/test-upload-content-security.cjs`: four actual decode
  scenarios, including corrupt raster/HTML/SVG and total animation budgets.
- `node --test infrastructure/media-gateway/worker.test.cjs`: 15 tests pass;
  MIME, authorization, cache, range and response-header boundaries covered.
- `node scripts/verify-r2-application.cjs`: actual upload HTTP controller/JWT,
  disposable full-schema PostgreSQL, uniquely isolated Redis image worker and
  real private R2/Worker. Evidence is `evidence/r2-application.json`.

The real integration run verifies generated immutable names, exact original
bytes, eight competing finalizers, expired-intent replay, overwritten staging,
12 decodable variants, denied cross-account access, selected-variant renewal,
malformed content refusal, revoked sessions and object/database/queue cleanup.
It does not certify an Android/iOS screen, full application deployment or the
current published Worker source. The application remains on S3 until cutover.

## Reference

[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
and [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## 28 October current activation check

The current source again passes 69 focused unit tests, four actual raster decode
checks and 15 Worker tests. The real HTTP/JWT/R2/isolated-Redis integration
passes all nine scenarios, produces 12 variants and cleans all 32 test objects.
The live gateway probe still passes its original eight boundaries, but the new
SVG-denial check fails: the published Worker uses the previous broad image MIME
rule. Deploy the prepared Worker allowlist before activation, then rerun the
live probe. Both temporary probe objects were removed. No storage activation
or deployed security sign-off is implied while that gate fails.
