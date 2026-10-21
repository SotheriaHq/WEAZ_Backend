# WIEZ: reading Sentry without reading the whole stack trace

An **issue** groups similar errors. An **event** is one occurrence. Start with the environment, time window, last-seen date, affected release, title and first **In App** frame. Library frames usually are not useful for initial triage.

## Daily workflow

1. Open Issues. Choose the environment you intend to check; avoid mixing SIT and production.
2. Choose the last 24 hours and Unresolved. If an older issue is absent, widen the window.
3. Prioritize failed checkout/payment, account access, data loss and widespread crashes. Compare recent event volume and affected users; counts alone do not establish business impact.
4. Open the issue. Check Last seen and release. Read the title and first In App stack frame.
5. Use breadcrumbs as context, not proof of causation. Match request ID, transaction and timestamps before connecting separate errors.
6. Copy the issue link and Copy as → Markdown. Share: what the shopper was doing, platform/app version, expected result and observed result. Do not include passwords, tokens or private customer records.
7. Verify the fix in the deployed release and affected journey, then resolve the issue. Resolve changes tracking status; it does not change the application. Recurrence can become Regressed.

## The supplied example: NODE-NESTJS-A / 134599405

The exported event is 2026-10-11 02:03:05 UTC, environment sit, release v2026.10.05-014717-047fb03. GET https://api.weaz.me/ failed with HTTP 500. The server rejected the Origin https://api.weaz.me in its CORS callback. This proves that request failed; it does not establish that shopper checkout failed, or that the issue remains active on 21 October.

- Handled: yes means caught/reported, not repaired. This event still returned 500.
- Users: 0 does not establish zero affected people; an event may lack an identified user. The current backend sets an opaque user ID only when authenticated request context exists.
- The screenshot's 1.5K total and one event in the selected view are different counters/scopes. Compare the same date/environment/release before interpreting a trend.
- Client Mobile Safari/iOS describes the request's reported client; Linux/Node describes the backend. A user-agent string is not proof of a real shopper.
- The first relevant frame is src/main.ts, the CORS callback. Do not edit node_modules/cors.
- The actual browser/server origin and deployed allowlist need verification. Do not fix this by allowing every origin with credentials or suppressing all CORS reports.
- Breadcrumbs include a physical-verification cron query reporting a missing column. A migration already defines reminderDayBeforeAt, reminderHourBeforeAt and awaitingReplyNudgedAt. Confirm the affected database's migration status and exact missing column before repair. This is separate from the demonstrated CORS exception.

## Current configuration, confirmed in source

Backend Sentry uses SENTRY_ENVIRONMENT/APP_ENV, SENTRY_RELEASE/GIT_SHA, a default trace sample rate of 0.1, and sendDefaultPii: false. The exception filter adds requestId, HTTP method/path/status, and the authenticated opaque user ID when available. It explicitly captures server errors (status >=500). That filter is not a complete inventory of every SDK capture path or client failure.

Backend: src/common/observability/sentry.instrument.ts and src/filters/All-exception.filter.ts. Web/mobile: src/observability/sentry.ts in each app. Deployed values, current Sentry settings, source-map upload health and alert recipients have not been independently verified in the live dashboard during this review.

## Recommended saved views and alerts

Keep separate environment views for backend, web and mobile. Start with new/regressed errors and unusually increasing failure frequency; use payment/auth business context for priority. Review the release after each deployment. Alert thresholds must follow observed traffic rather than invented user counts. No notification recipients or live dashboard settings were changed by this guide.

Ask for an engineering explanation in this format: **What failed / Who may be affected / Confirmed evidence / What remains unknown / Fix / Verification**.

Sources: [Sentry Issue Details](https://docs.sentry.io/product/issues/issue-details/), [Issue Status](https://docs.sentry.io/product/issues/states-triage/), [Breadcrumbs](https://docs.sentry.io/platforms/javascript/guides/svelte/enriching-events/breadcrumbs/).
