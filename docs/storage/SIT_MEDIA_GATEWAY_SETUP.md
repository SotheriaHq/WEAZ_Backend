# SIT private-bucket media gateway

The owner deployed the reviewed Worker at
`https://wiez-sit-media-gateway.sotheria-hq.workers.dev`. Its private bucket
binding is `MEDIA_BUCKET` → `wiez-sit-media`. All nine live gateway probes pass,
including SVG415 rejection; see [evidence](evidence/r2-sit-gateway-smoke.json).
This verifies the Worker, not the backend application cutover. Public media
requires API-issued capabilities after publication checks; private evidence,
orders and messages use authorized R2 SDK delivery.

## Dashboard setup

1. In the Cloudflare account containing the SIT bucket, open Workers & Pages
   and create a Worker named `wiez-sit-media-gateway`. If it already exists,
   open that Worker instead. Do not replace an unrelated Worker.
2. Confirm Domains & Routes shows the owner-provided endpoint
   `https://wiez-sit-media-gateway.sotheria-hq.workers.dev`. This URL is public;
   credentials are not needed to identify the endpoint.
3. Open the code editor and replace the template with the complete module at
   [`worker.mjs`](../../infrastructure/media-gateway/worker.mjs).
4. Add an R2 bucket binding: variable `MEDIA_BUCKET`, bucket `wiez-sit-media`.
   The Worker uses this private binding and does not need the backend's R2
   access-key pair.
5. Add the following variables and the separately stored secret. Use the actual
   copied HTTPS Worker URL as the base, without a trailing slash.

| Name | Value/type |
| --- | --- |
| `MEDIA_GATEWAY_BASE_URL` | Exact copied Worker URL; plain text |
| `MEDIA_GATEWAY_ENVIRONMENT` | `sit`; plain text |
| `MEDIA_GATEWAY_MAX_TTL_SECONDS` | `900`; plain text |
| `MEDIA_GATEWAY_ALLOWED_ORIGINS` | `https://weaz.me,http://localhost:3000,http://localhost:5173,http://localhost:5174,http://192.168.110.91:3000`; plain text |
| `MEDIA_GATEWAY_CACHE_VERSION` | `v1`; plain text |
| `MEDIA_GATEWAY_SECRET` | Secret; same strong secret as the backend signing configuration |

6. Save and deploy the reviewed module with its binding and variables. The
   secret must be entered through Cloudflare's secret field or secure tooling,
   never pasted into chat, source code or command history. Do not reuse an R2
   access secret as the gateway secret. Disable preview URLs; the configured
   audience must have one canonical public endpoint.
7. Keep the bucket's `r2.dev` and direct public custom-domain access disabled.
   The authenticated Worker's `workers.dev` endpoint is separate from the
   bucket's public `r2.dev` endpoint.

See [Cloudflare's dashboard workflow](https://developers.cloudflare.com/workers/get-started/dashboard/)
and [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Local deployment configuration

Generate a concrete config from the confirmed public endpoint without credentials:

```powershell
node infrastructure/media-gateway/create-sit-config.cjs --base-url https://wiez-sit-media-gateway.sotheria-hq.workers.dev --transport workers-dev
```

This creates `infrastructure/media-gateway/wrangler.sit.toml` and refuses to overwrite
an existing file. It performs no deployment or environment switch. Its binding
and CORS values match the table above. Origins are read from the explicit
approved list in [`r2-sit-cors.json`](r2-sit-cors.json). Supply `--jurisdiction eu`, `us` or
`fedramp` only when that is the bucket's confirmed jurisdiction.

A confirmed custom zone can instead use `--transport route --zone-name ZONE`
or `--transport custom-domain --zone-name ZONE`. A route needs an active
Cloudflare zone and proxied DNS. A successful HTTP response from the website
alone does not prove those conditions. The generator does not verify ownership.
See [routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Deployment authorization

An R2 Object Read/Write key is not a Worker deployment credential. For an
existing Worker, Cloudflare's current granular model permits Worker-scoped
Editor access. Creating a Worker requires Workers-product Admin; changing
custom routes also requires the relevant zone's Workers Routes Write access.
An existing R2 binding does not require extra R2-resource permission merely to
deploy. Prefer an account-owned token limited to the existing Worker when
automating deployment. OAuth login currently lacks granular authorization.
See [current Workers access rules](https://developers.cloudflare.com/workers/authorization/).

Local metadata inspection found no project/global Wrangler executable, cached
Wrangler package, common OAuth credential file, or Cloudflare auth environment
variable. No credential contents were inspected. The npm registry reported
Wrangler `4.151.3`, requiring Node `>=22.0.0`, on 2026-10-22. After separately
authorizing setup, these pinned commands avoid changing app dependencies:

```powershell
npx --yes --package=wrangler@4.151.3 wrangler --version
npx --yes --package=wrangler@4.151.3 wrangler secret put MEDIA_GATEWAY_SECRET --config infrastructure/media-gateway/wrangler.sit.toml
npx --yes --package=wrangler@4.151.3 wrangler deploy --config infrastructure/media-gateway/wrangler.sit.toml
```

These commands are instructions, not actions performed by this change. Use
secure process authentication for `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; do not print their values. See
[Wrangler authentication and secret handling](https://developers.cloudflare.com/workers/wrangler/commands/general/).

## Activation checks

After dashboard deployment and secure local gateway configuration, run:

```powershell
node scripts/verify-r2-media-gateway.cjs
```

This uses the actual backend signer, creates one disposable PNG in the SIT
bucket, checks signed GET/HEAD, conditional ranges, ETags, approved/untrusted
CORS, and invalid/expired token denial against a warmed path. It deletes the
temporary object and verifies 404 afterward, including after a failed upload
attempt. Its report contains no credentials or bearer URLs. A starter Worker
or missing configuration fails readiness before any object is written.
Internal edge-cache hits are not externally observable; the local Worker suite
tests authorization before a mocked cache hit. The live probe does not prove
API parent authorization: deployed public/private API fixtures and real client
lifecycle checks below remain separate release gates.

Before enabling gateway configuration in an app environment, verify:

- API-issued public-eligible image URLs return 200; HEAD, ETags and byte ranges
  behave correctly. The selected original or variant must be preserved.
- Unsigned, tampered, expired, wrong-environment and wrong-host requests fail,
  including requests against an already warm cache.
- Private verification/order/message objects never receive public gateway
  capabilities. Private renewal preserves canonical participant access.
- CORS works for the approved origins above and rejects an untrusted
  origin's preflight. Add other origins only after explicit verification.
- Actual web/Android/iOS clients recover after idle, cache restoration and
  foregrounding, and stop showing private media after account changes.
- Direct bucket public access remains disabled, and no alternative route
  bypasses signature checks.

The backend should use the same base URL, environment and secret, with
`MEDIA_GATEWAY_TTL_SECONDS=300` (accepted range 60–900). Already issued public
capabilities remain usable until their bounded expiry; this is not immediate
revocation. Do not change `active.env` or release an APK merely because local
unit tests pass.

The current renewal batch-to-GET compatibility fallback is a cutover-removal
candidate. Retain it until the current backend and APK are deployed; the
separately authorized SIT/local reset does not by itself upgrade installed
clients.
