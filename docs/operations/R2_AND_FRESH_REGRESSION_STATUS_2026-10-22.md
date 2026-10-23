# R2 and fresh regression verification — updated 23 October 2026

## Verified locally

- Private SIT bucket: wiez-sit-media. Object write/read, conditional copy, immutable-copy behavior, range reads, signed requests and safe cleanup passed the real R2 storage smoke.
- Browser upload CORS passed for https://weaz.me and localhost:5173; untrusted origin denied. Bucket remains private.
- Upload completion now uses staging objects, byte-signature validation, conditional immutable copy, a short fenced database publication transaction, durable cleanup and recoverable image dispatch. Server-mediated uploads and verification PDFs use the same completion path. Silent local-disk fallback and public local-upload serving were removed.
- Design finalization delegates file state/replay checks to the shared upload engine; it no longer acknowledges processing before successful queue admission.
- PostgreSQL timestamp(3) values use UTC. Every runtime Prisma connection and reference-seed/CLI connection requests UTC at startup; runtime startup checks the effective setting. Upload/image lease SQL uses explicit UTC timestamps and checks lease validity in a separate statement after acquiring the row lock.
- Full current history: 141 migrations applied successfully to a disposable local database. The four paid subscription tiers remain; only the internal grandfather tier/flag is retired. No existing local or SIT application database was reset by this check.
- Reference-only bootstrap passed twice in the disposable database: 1 admin, 38 measurements, 46 size charts, 130 tags, 13 garment categories, 21 settings, 2 settlement policies; 0 content records and 0 uploaded-file records. Existing tag moderation and existing admin password/suspension/reset state are preserved on reseed.
- Initial admin creation requires a securely supplied SYSTEM_ADMIN_PASSWORD of 16–128 characters; no shared hardcoded password is used.

## Evidence and checks

- docs/storage/evidence/r2-sit-storage-smoke.json
- docs/storage/evidence/verify-r2-finalize-concurrency.json: 13 assertions, including actual generated-Prisma claim competition and non-UTC database sessions.
- docs/storage/evidence/verify-r2-shared-media-access.json: 25 authorization assertions.
- docs/storage/evidence/fresh-schema.json: 141 migrations and two reference seed runs.
- docs/storage/evidence/subscription-tier-contraction.json: six real PostgreSQL scenarios verify paid tier/FK preservation and rejection/rollback of grandfather references or occupied paid orders without queue lanes.
- docs/storage/evidence/r2-sit-gateway-smoke.json: eight live checks passed at https://wiez-sit-media-gateway.sotheria-hq.workers.dev, including signed GET/HEAD, range/ETag, invalid/expired capability rejection on a warm path, CORS, direct R2 denial and verified disposable cleanup. This does not establish API private-parent authorization or internal edge-cache hit rates.
- Upload/image/cleanup/UTC unit suites: 49 passed. Admin bootstrap security: 3 passed.
- Backend and web full TypeScript checks passed after the latest code changes. The latest focused backend run passed eight suites/88 tests covering queue/payment admission, configuration reads/request parsing, payout batching and search refresh. Native full TypeScript and15picker behavior checks passed; web picker lifecycle6checks passed.
- Reset safety7checks passed. Reset is database-only by default; exact host/database and initial admin credential preflight are required, storage deletion is separately explicit, credentials are redacted and filesystem redirects refused.
- Production dependency audit reports zero vulnerabilities. The development/test dependency tree has29high findings through the unpatched braces/Jest chain; no forced major upgrades were applied. Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm.

## Runtime verification and query improvements

- Server preflight verified the documented SIT checkout at /home/ec2-user/WEAZ_Backend, commit768aba1, with API/worker online. Database identity is localhost:5432/wiez_sit. It still uses S3; no gateway config has been applied there. One occupied PAID order has a NULL queue lane; the contraction migration correctly refuses an in-place upgrade until the authorized fresh reset.
- Custom-order configuration reads preserve explicit measurement choices and no longer infer smaller legacy templates. Public visibility is checked once per source; freeform point metadata is hydrated in batches of500 unique IDs with brand isolation. Strict DESIGN-domain ownership replaces the old cross-domain allowance. HTTP isActive=false now remains false under implicit conversion, and invalid boolean strings are rejected.
- Payout source selection retains oldest-first/partial allocation and release stages; only selected ORDER hold metadata is fetched in bounded500-ID batches instead of one query per ledger entry.
- Brand search refresh uses hydrated keyset pages of250 products and at most8 concurrent index writes, replacing whole-catalog Promise.all and one database re-read per product. These are enforced work bounds, not measured production capacity.
- SIT now runs the backend quality gate; upload privacy/finalization regressions, reset safety and production dependency audit also block deployment. Deploy bootstrap seeds all reference/admin data rather than only measurements/tags/admin.

## Remaining release gates

1. Gateway deployed and live checks passed. Finish application configuration and verify API-issued public capabilities plus private parent authorization through the deployed API.
2. Rotate the R2 token that appeared in a credential screenshot before real-data cutover. Do not copy screenshots/keys into logs, source control or issue reports.
3. Validate public gateway caching, token expiry, range/CORS/ETag behavior and private-media isolation against the deployed Worker. Configure the API and worker processes with the same R2 and gateway settings; .env.r2.local is intentionally not auto-loaded by the running API.
4. Finish remaining old-data-only compatibility and query/race inventory. Grandfathered subscription/order branches are retired locally with strict migration guards; current captured-payment recovery remains. Keep current lifecycle, privacy, default-business and recovery behavior. Applied migration history remains immutable.
5. Verify exact SIT database identity and isolation from production, stop relevant writers, then perform the owner-authorized SIT and local resets and complete reference/admin bootstrap. Do not wipe an arbitrary storage bucket or shared Redis server.
6. Complete full combined release checks, commit/push all release changes before the GitHub APK build. Notifications are deliberately last per owner priority; conditional settings/default/recovery edits are preserved but not yet release-certified. Photo-picker recovery checks passed locally; physical device upload regression remains.
7. Preserve/merge branch work before cleanup. Main and SIT are the intended retained branches; local-versus-GitHub deletion scope still needs resolution.

## Native push observation

The attached Android phone initially reported WIEZ POST_NOTIFICATIONS granted=false. After the owner enabled it in Android settings, ADB verified granted=true. Registration/recovery and build-time Firebase provisioning remain under review; permission repair alone is not a delivery certificate. USB stay-awake was enabled for the connected test session and must be restored to its original value (0) when testing ends.
