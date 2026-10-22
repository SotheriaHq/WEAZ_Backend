# WIEZ Telegram monitoring

Private, outbound-only Telegram alerts and twice-daily reports for one environment. SIT uses bot `@wiez_sit_bot`; UAT and production must each get their own bot, token and chat.

## Architecture

```
business services ──record()──┐                    ┌── Telegram Bot API (sendMessage)
MonitoringService.emitAlert ──┤                    │
Sentry webhook (API) ─────────┼─> BullMQ queue ────┤  worker: TelegramMonitoringProcessor
                              │   telegram-monitoring   concurrency 1, limiter 1 msg/s
job schedulers (Redis) ───────┘   (existing Redis)  └── reports 07:00/22:00 Lagos, watchdog every 5 min
API @Interval (2 min) ── worker heartbeat watch ── direct send (the queue may be what is broken)
```

- No new server, database, Redis, daemon or dependency. Native `fetch`, existing BullMQ/Redis/Prisma.
- Code: `src/telegram-monitoring/`. Shared module is imported by `AppModule` and `QueueWorkerModule`; the processor and scheduler run only in the worker.
- `record()` is synchronous and never throws. Counting and enqueueing run detached with a 5 s cap, so Redis or Telegram problems cannot slow or fail a user request. Hooks are placed after the business transaction commits.
- Redis keys are prefixed `wiez:tgmon:<environment>:` so environments sharing a Redis stay isolated.

## Event catalog

| Event | Trigger (service boundary) | Delivery |
|---|---|---|
| `user.registered` / `brand.registered` | `AuthService.CreateUser`, `googleAuth` (new account) after commit | immediate |
| `auth.signup_system_failure` | signup threw a system error (DB, username/number generation, hashing, session) | immediate |
| `auth.signup_rejected` | duplicate email, password policy, missing fields, legal | 15 per hour → one alert; always counted |
| `brand.verification_decided` | `BrandVerificationService.review` (documents), `PhysicalVerificationService.decide` (final) | immediate |
| `payment.succeeded` / `payment.failed` | `PaymentService.applyAttemptStatus` when it performs a terminal transition (row-locked, once per attempt) | immediate |
| `checkout.completed` | `finalizeUnifiedCheckoutAttempt` after orders/custom orders commit (deduped by reference) | immediate |
| `design.publish_failed` | `DesignsService.reportDesignPublishFailure` (owner-verified) | 3 per hour → one alert |
| `operational.alert` | `MonitoringService.emitAlert`: critical, admin-routed (payment webhook signature/amount/unknown ref, finalization compensation, upload owner mismatch, break-glass, high-severity content reports) or error-level PAYMENT/WEBHOOK/UPLOAD/QUEUE/SECURITY | immediate, at most every 30 min per alert |
| `http.server_error` | 5xx via exception filter (each also in Sentry) | 20 per hour → one alert |
| `http.auth_failure` | 401/403 | counted only |
| queue failures | watchdog: failed-job count increased (image processing, webhooks, notifications, …) | immediate, 30 min cooldown per queue |
| infra | watchdog: DB, Redis, API `/healthz`, memory < 150 MB, swap ≥ 80 %, disk ≥ 85 %, backlog ≥ 300; API: worker heartbeat stale | on change (down and recovered) |
| `sentry.alert` | Sentry alert rule → webhook | immediate, same issue+rule+level at most every 30 min |

Likes, follows, comments, saves, wishlist adds and logins are never messaged; they appear in reports.

Not instrumented (with reasons): upload finalize/image processing internals (files had in-progress changes; covered instead by queue-failure alerts and report counts from `FileUpload.processingStatus`); product publish success per event (report counts only).

## Message content

User-activity messages include username, email, user ID and a timeline (event time, account created, checkout started/confirmed) when `TELEGRAM_INCLUDE_USER_IDENTITY=true`. This was an owner decision for SIT; review it before production, because Telegram stores message history on its servers. With the flag off, only an 8-character ID prefix is shown.

Sentry messages include project, environment, rule, issue short ID, occurrences, affected users, release, endpoint (method + path), response status, transaction, request ID, error type and message, the crashing in-app frame (file:line, function), handled/unhandled, runtime/OS/browser/device, user ID, event ID, first/last seen, and links to the issue and the event.

Never sent: stack traces beyond that one frame, request headers, cookies, request bodies, query strings, breadcrumbs, passwords or tokens. Error text is scrubbed of emails, credentialed URLs and long tokens. Messages are plain text (no parse mode), and links are dropped unless they are `https` on `sentry.io`, `weaz.me`, `wiez.com` or `weaz.com` (and subdomains).

## Environment variables (`.env` on the server, never committed)

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_MONITORING_ENABLED` | yes | `true` to activate; anything else disables all sends and removes schedulers |
| `TELEGRAM_BOT_TOKEN` | yes | from BotFather; per environment |
| `TELEGRAM_ADMIN_CHAT_ID` | yes | the only destination (allowlist); SIT owner chat is private |
| `TELEGRAM_ENVIRONMENT` | yes | label on every message: `SIT`, `UAT`, `PROD` |
| `TELEGRAM_INCLUDE_USER_IDENTITY` | no | default `false`; SIT `true` |
| `TELEGRAM_REPORTS_ENABLED` | no | default `true` |
| `TELEGRAM_REPORT_TIMEZONE` | no | default `Africa/Lagos` |
| `TELEGRAM_HEALTHCHECK_URL` | no | default `http://127.0.0.1:$PORT/healthz` |
| `SENTRY_WEBHOOK_CLIENT_SECRET` | for Sentry alerts | the internal integration's **Client Secret** |
| `SENTRY_ALERT_ENVIRONMENTS` | no | Sentry environments to forward; default `SENTRY_ENVIRONMENT` (SIT: `sit`) |
| `SENTRY_API_TOKEN`, `SENTRY_ORG_SLUG` | optional | read-only token (`event:read`, `project:read`, `org:read`) for counts and report statistics |
| `SENTRY_API_BASE_URL` | no | default `https://sentry.io` (use `https://de.sentry.io` for EU orgs) |

After editing: `cp .env .env.bak.$(date +%s)` first, then `pm2 restart weaz-api weaz-worker --update-env`.

## Sentry integration setup (one-time, per environment)

1. Sentry → Settings → Developer Settings → Custom Integrations → **Create New Integration → Internal Integration**.
2. Name `WIEZ Telegram (SIT)`. Webhook URL `https://api.weaz.me/webhooks/sentry`. Turn on **Alert Rule Action**. Permissions: Issue & Event **Read**, Project **Read**, Organization **Read**. Webhooks: none needed (alert rules deliver through the action).
3. Save. Copy the **Client Secret** to `SENTRY_WEBHOOK_CLIENT_SECRET`. Optionally create a token on the integration and set `SENTRY_API_TOKEN` plus `SENTRY_ORG_SLUG`.
4. Create alert rules for the backend project with environment `sit`, each with the action "Send a notification via WIEZ Telegram (SIT)":
   - **Issue alert:** "A new issue is created".
   - **Issue alert:** "The issue changes state from resolved to unresolved" (regressions).
   - **Issue alert:** "The issue's level is equal to fatal" plus "An event is seen".
   - **Issue alert:** "The issue is seen more than 50 times in 1h" (spikes; tune to traffic).
   - **Issue alert:** tag `transaction` contains `image` or `worker` errors (image processing / worker crashes).
   - **Metric alert (optional):** error count above a threshold in 10 minutes; critical and resolved both deliver.

Verification: Sentry signs each request (`Sentry-Hook-Signature` = HMAC-SHA256 of the body with the client secret). The endpoint rejects a missing secret (503), a bad signature (401) or a timestamp more than 10 minutes off (401). It forwards only alerts whose environment is in `SENTRY_ALERT_ENVIRONMENTS`. Issue-resource webhooks carry no environment and are never forwarded.

## Scheduled reports

- 07:00 Lagos covers [22:00 the previous day, 07:00). 22:00 Lagos covers [07:00, 22:00). Windows are half-open and contiguous, so nothing is counted twice.
- BullMQ job schedulers (`telegram-report-morning`, `telegram-report-evening`, `telegram-infra-watchdog`) are upserted on every worker boot; this is idempotent.
- Duplicate protection: a delivery record per (kind, window end) in Redis, kept 35 days. A restart, retry or late run finds the record and stops; a crash mid-send resumes from the first unsent part. The last 60 deliveries are kept in `report-log`.
- Sections: platform activity (users, brands, uploads, products, designs, orders, payments, engagement, signed-in users as a lower bound), failed operations and alerts (live counters), Sentry (webhook count, plus new/regressed/fatal/top issues when an API token is set), and infrastructure at report time.
- Each query is capped server-side (`statement_timeout` 5 s) and degrades independently. "unavailable" means the source could not be read, never zero.

## Commands (on the server, in `~/WEAZ_Backend`)

```bash
npm run monitoring:telegram -- check                       # config + getMe, sends nothing
npm run monitoring:telegram -- test-message --note="after deploy"
npm run monitoring:telegram -- report --kind=morning        # preview to stdout
npm run monitoring:telegram -- report --kind=evening --send # preview delivered, marked PREVIEW
npm run monitoring:telegram -- report --kind=morning --at=2026-10-22T06:00:00Z --scheduled  # real path; rerun shows "duplicate"
npm run monitoring:telegram -- report-log
npm run monitoring:telegram -- watchdog --dry-run
npm run monitoring:telegram -- sentry-test-error            # labelled synthetic error; refused in production
npm run monitoring:telegram -- sentry-webhook-selftest      # signed sample alert to the local webhook
npm run monitoring:telegram -- sentry-webhook-selftest --bad-signature   # expect 401
```

The CLI starts a small Nest context (about 150 MB for a few seconds). Avoid running it during a deploy on the 1.9 GB SIT box.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | `check` reports problems; `pm2 logs weaz-worker` for `Telegram monitoring active`; is `weaz-worker` running? |
| `fatal (401)` | token revoked or wrong; replace `TELEGRAM_BOT_TOKEN` |
| `fatal (400) chat not found` / `(403) blocked` | owner must open the bot and press Start; check the chat ID |
| Bursts arrive slowly | intended: 1 msg/s; a 429 pauses the queue for Telegram's `retry_after` |
| No Sentry alerts | secret set? rule environment `sit`? rule action targets the integration? logs show `Rejected Sentry webhook`? |
| Report missing | `report-log`; worker down at 07:00 means it runs when the worker returns (same window) |
| Report duplicated | should not happen; inspect `wiez:tgmon:sit:report:*` |

## Rolling out to UAT or production

1. Create a new bot in BotFather (`WIEZ_UAT`, `WIEZ_PROD`) and have the recipient press Start.
2. Set the variables above on that environment's server with its own token, chat ID and `TELEGRAM_ENVIRONMENT`. Never reuse the SIT bot.
3. Create a separate Sentry internal integration (webhook URL for that API) and rules filtered to that environment; set `SENTRY_ALERT_ENVIRONMENTS` accordingly.
4. Decide `TELEGRAM_INCLUDE_USER_IDENTITY` for production deliberately (privacy notice and retention).
5. Before production volume, add `createdAt` indexes for `User`, `Brand`, `Order`, `FileUpload`, `Follow`, `CollectionReaction`, `CollectionComment`, `WishlistItem`, and `RefreshToken.lastUsedAt`. Report counts on those tables are sequential scans today; that is fine at SIT size.
6. Run `check`, `test-message`, `report --send` and `sentry-webhook-selftest` on that server.

## Known limitations

- If both the API and the worker are down, nothing can alert; an external uptime check is still needed for production.
- Signed-in users is a lower bound: `RefreshToken.lastUsedAt` is overwritten on rotation.
- "Products/designs published" counts items created in the window that are published now; there is no `publishedAt` column.
- Live failure counters live in Redis (8-day TTL). They reset if Redis data is lost, but database-derived metrics do not.
- Telegram is a third party: message history containing emails and usernames is stored by Telegram.
