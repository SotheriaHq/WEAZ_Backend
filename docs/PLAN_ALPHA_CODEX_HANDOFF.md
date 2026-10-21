# Plan Alpha — Codex handoff (2026-10-21)

## Scope and safety
This is a **branch-only, unmerged, undeployed** implementation of backend image memory optimization, queue reliability, and future Cloudflare R2 readiness. Branch: `feat/plan-alpha-image-processing-r2-readiness`, based on `main`. **Do not merge, deploy, change EC2, or touch payment/subscription modules** as part of this handoff. `SIT` was four commits ahead of `main` when work began and contains overlapping image and unrelated payment changes. Review merge conflicts against BOTH targets carefully. The owner will coordinate integration with other Codex branches.

## Changes made
1. `src/media-processing/media-processing.service.ts`: introduced `generateVariantsIter()`, an async generator yielding one encoded variant at a time. Kept `generateVariants()` as a compatibility wrapper returning an array for existing callers. Existing profile dimensions, quality settings, format selection and image encoding are retained. An earlier Sharp `resize` syntax error was corrected.
2. `src/queue/image-processing.processor.ts`: uses `for await` to encode, upload and upsert one variant at a time, instead of accumulating all variants before upload. READY is updated after all required variants finish. Re-encode retains the old asset version on failure; old DB variant rows are deleted only after version switch. Legacy batch processing attempts every file and throws a batch error if any normal file failed so BullMQ doesn't report a false success.
3. `src/queue/image-processing.queue.service.ts`: new `enqueueBatch()` calls `queue.addBulk` with one independently retryable single-file job per unique file ID. Existing legacy batch handler remains for already queued jobs. Four attempts, exponential 1.5s backoff.
4. `src/upload/upload.service.ts`: optional `S3_ENDPOINT` config for S3-compatible object stores (path-style), optional `S3_PUBLIC_BASE_URL` for generated public URLs; presigned POST uses SDK-returned URL when custom endpoint configured; skips public-read ACL when custom endpoint configured. AWS behavior remains default when these vars are absent.
5. `src/queue/image-processing.processor.spec.ts`: updated generator fixture, asserted READY after upload and legacy batch failure propagation.

## Verification status — DO NOT CLAIM PASS
Only repository inspection and GitHub's **Agent Hygiene** workflow have been observed. There is **no confirmed TypeScript build, Jest test pass, R2 integration test, memory benchmark, or EC2 verification** for this branch. The branch is a handoff candidate, not production-ready.

## Codex execution checklist
- Run `npm ci`, `npx prisma generate`, `npm run build`, and `npm test -- src/media-processing/media-processing.service.spec.ts src/queue/image-processing.processor.spec.ts src/upload/upload.service.spec.ts --runInBand`. Correct all failures on this branch. Review `tsconfig` / strict compiler settings and ESLint.
- Add a generator parity test with actual JPEG/PNG samples: iterator variants should match old `generateVariants` outputs in kind/format/dimensions and be decodable. Test HEIC and animated image behavior where supported.
- Add multi-variant ordering tests: variant 2 must not encode until variant 1 upload/upsert has completed; failed upload must not mark READY. Test reencode partial failure preserves old version, and retry semantics for normal and legacy batch jobs.
- **Important design review:** legacy batch retries with `force: true` can reprocess successful files. New batch enqueues singles; consider a durable failed-file-only retry strategy for old jobs. Avoid deleting valid previously visible images.
- **Important memory review:** original image is still read into a full Buffer and Sharp decoded memory remains significant. Incremental output reduces accumulated encoded buffers but does not guarantee an OOM-free worker. Inspect Multer `memoryStorage`, input file size caps, Sharp concurrency/cache, worker concurrency (`IMAGE_PROCESSING_CONCURRENCY` defaults 2), and peak RSS. Compare before/after with realistic 12–30 MP photos and batch loads.
- **R2 integration review:** validate presigned POST against actual R2 account and SDK signature requirements, credentials, region, custom endpoint, public CDN base URL, CORS, bucket policy, and object ownership. Check all upload methods (not only `putObjectBuffer`) for hard-coded AWS URL/ACL assumptions; current changes are **partial R2 readiness, not migration**. Existing S3 objects/URLs must keep working; do not flip env vars or move objects.
- Review potential cache/URL mismatch: custom public URL is only used for newly generated object URLs; old database URLs remain AWS-based by design.
- Confirm immediate local preview behavior and progress states in mobile/web clients; this backend branch alone does not modify client UI.
- Run isolated queue tests for failures, backfills, retry exhaustion, stalled jobs, and mixed good/bad batch entries. Ensure failed jobs remain discoverable/recoverable.
- Check `SIT` branch's more recent image processing before reconciling this main-based branch; avoid accidentally overwriting SIT's image quality and worker fixes or importing unrelated payment changes.
- Record command output, tests passing/failing, peak RSS and elapsed timings. Keep deployment/EC2 work with Codex per user instruction. **No merges or deployments without user coordination.**

## Intended behavior
Users keep local previews immediately; variant encoding runs asynchronously. A file becomes READY only after successful variant upload. Existing immutable versioned keys and quality settings stay intact. Re-encode failure must not hide a previously READY photo. R2 configuration is opt-in and should not affect current AWS deployments.
