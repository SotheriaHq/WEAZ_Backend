# WIEZ: reading Sentry, in plain language

Sentry collects errors from the WIEZ server, website and app. This guide
explains what you are looking at and what to do about it.

## The words that matter

| Sentry word | What it means |
|---|---|
| **Event** | One error, once: one person, one moment. |
| **Issue** | A group of events Sentry thinks are the same problem. One issue can hold thousands of events. |
| **Environment** | Where it happened: `sit` (test) or `production` (real customers). Never mix them when judging how bad something is. |
| **Release** | Which version of WIEZ was running, e.g. `v2026.10.05-014717-047fb03`. The last part is the code version. |
| **Last seen** | When it last happened. An issue last seen before the latest release may already be fixed. |
| **Users** | How many signed-in people Sentry could identify. Guests and failures before sign-in count as zero, so "0 users" does not mean "nobody was affected". |
| **Handled** | "Yes" means the code caught the error and reported it. It does **not** mean the person's action succeeded. |

## Reading one issue, top to bottom

1. **Check the environment and release first.** A production issue on the
   current release matters most. A `sit` issue on an old release may be history.
2. **Read the title.** It is the error's own message, e.g. "Origin is not
   allowed by CORS" or "column X does not exist".
3. **Find the first "In App" line in the stack trace.** The stack trace lists
   every function that was running when it failed, deepest first. Lines marked
   *In App* are WIEZ code; the rest are libraries. The first In App line is
   where to start (e.g. `src/main.ts`, the CORS check).
4. **Look at the breadcrumbs.** They are the trail of things that happened just
   before the error: requests, database queries, page changes. They give
   context; they do not prove what caused what.
5. **Match the request ID** when two errors might be related. The same request
   ID means the same request.

## Is it a bug, an old deployment, a missing database change, or a setting?

| What you see | Most likely | How to check |
|---|---|---|
| "column … does not exist", "relation … does not exist", Prisma `P2021`/`P2022` | A database change (migration) has not been applied where this ran | The deploy log or the migration list for that database |
| The issue's release is older than what is running now, and it has not been seen since the deploy | Already fixed by a later deployment | Compare **Last seen** with the deploy time; the running version is in the release name |
| "is not configured", "Origin is not allowed", missing key, wrong URL | A setting (environment variable) | The server's `.env` for that environment |
| Same error on the **current** release, with real user steps in the breadcrumbs | A real defect in the app | Hand it to engineering (format below) |

Never make an error disappear by ignoring it or turning reporting off. An
issue is resolved when the cause is fixed, not when the dashboard is quiet.

## What to look at first

1. Payments, checkout, refunds and payouts.
2. Signing up and signing in.
3. Anything that loses or corrupts data.
4. Crashes many people hit, then **New** and **Regressed** issues.
5. Everything else, by how often it happens **and** who it affects. A loud
   issue on one test account is less urgent than a quiet one in checkout.

## Resolve, reopen, ignore

- **Resolve** only after the fix is deployed and you have checked the same
  journey works. "Resolve in next release" is the safest choice.
- **Regressed** means a resolved issue came back. Treat it as new.
- **Ignore / archive** only for confirmed noise (for example a bot hitting a
  page that does not exist). Write down why.
- Resolving changes Sentry's bookkeeping. It does not change WIEZ.

## What Sentry never receives

Before anything leaves the server, website or app it is scrubbed (server:
`src/common/observability/sentry-scrub.ts`; web and app:
`src/observability/sentry.ts`). Removed:

- passwords, sign-in tokens, reset and verification links' tokens;
- payment keys and saved-card authorization codes;
- signed media links (the part that grants access);
- email addresses, cookies, request bodies and query strings.

Checkout recovery credentials inside `/custom-orders/resume/<token>` and
`/custom-orders/checkout-sessions/resume/<token>` are also removed from request
URLs, endpoint tags, errors, breadcrumbs, spans and logs. Ordinary order IDs
remain available for diagnosis. CI and deployment both test this distinction.

Kept: the page or endpoint path, the error message (scrubbed), the code
location, the release, and an opaque user ID for signed-in people. On the
website and app, performance tracing starts only after the visitor allows
analytics; error reports do not need it.

## Telegram alerts

Sentry alerts are summarised into the WIEZ Telegram channel (see
`TELEGRAM_MONITORING.md`). The summary is scrubbed the same way and links
back to the issue. On SIT, `TELEGRAM_INCLUDE_USER_IDENTITY=true` (your
decision) adds usernames and emails to user-activity alerts; turn it off
before production, because Telegram keeps message history on its servers.

## Asking engineering about an issue

Send the issue link and say:
**What failed / Who may be affected / Confirmed evidence / What remains
unknown / Fix / How it was verified.** Never paste passwords, tokens or
customer records into the request.

## Worked example: NODE-NESTJS-A / 134599405

2026-10-11 02:03:05 UTC, environment `sit`, release
`v2026.10.05-014717-047fb03`. `GET https://api.weaz.me/` returned 500 because
the server's CORS check refused the origin `https://api.weaz.me`.

- It proves that request failed. It does not show checkout failed, or that the
  issue still happens (check Last seen against later releases).
- "Handled: yes" and "Users: 0" do not mean harmless; see the table above.
- Start at `src/main.ts` (the CORS check). Do not fix it by allowing every
  origin or by silencing CORS reports.
- A breadcrumb in the same event shows a missing database column in a cron
  query: a separate, migration-type problem (first row of the table).

## Configuration (checked 2026-10-29)

SIT: Sentry DSN set, `SENTRY_ENVIRONMENT=sit`, release stamped by
`scripts/deploy.sh` (`SENTRY_RELEASE`, `GIT_SHA`), running `bd7aefe`. Trace
sample rate defaults to 0.1. Source-map upload health, alert recipients and
current dashboard issues were not reviewed: that needs a Sentry login or API
token, which this review did not have.

Sources: [Issue details](https://docs.sentry.io/product/issues/issue-details/),
[Issue states](https://docs.sentry.io/product/issues/states-triage/),
[Breadcrumbs](https://docs.sentry.io/platforms/javascript/enriching-events/breadcrumbs/).
