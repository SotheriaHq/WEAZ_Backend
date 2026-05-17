# Bagging Performance Observability

Phase 14 adds timing instrumentation only. It does not optimize response time or change eligibility behavior.

## What Is Measured

- Backend `BagEligibilityService` product status resolution duration.
- Backend `BagEligibilityService` source status resolution duration.
- Backend custom duplicate classification duration.
- Backend `BagCountPresenter` combined count duration.
- Web `BagApi.getProductBagStatus` request duration.
- Web `BagApi.getSourceBagStatus` request duration.
- Mobile `MobileStoreApi.getSourceBagStatus` request duration.

## Where Logs Appear

- Backend: Nest `Logger.debug` under the `BagEligibilityService` or `BagCountPresenter` context.
- Web: browser/devtools console through `console.debug('[bagging:timing]', ...)`.
- Mobile: Metro/device debug console through `console.debug('[bagging:timing]', ...)`.

## Log Guards

- Backend logs in non-production or when `BAGGING_OBSERVABILITY=true` or `BAGGING_OBSERVABILITY=1`.
- Web logs in dev/test/E2E or when `VITE_BAGGING_OBSERVABILITY=true`.
- Mobile logs in `__DEV__`, test, or when `EXPO_PUBLIC_BAGGING_OBSERVABILITY=true`.

Production is quiet unless the explicit observability flag is enabled.

## Current Expected Slow Points

- Source eligibility for custom flows can read source data, measurement profiles, custom-order configuration, active bag lines, and duplicate custom-order state.
- Duplicate classification can traverse active custom checkout sessions and active paid custom orders.
- Bag count can aggregate standard cart quantity and custom checkout bag lines.
- Cold local E2E startup is dominated by backend and Vite server boot, not bagging response time.

## Optimization Candidates For A Later Phase

- Capture p50/p95 timing from seeded E2E and a real staging session before changing behavior.
- Add request de-duplication on web/mobile if the same source status is requested repeatedly during one interaction.
- Review database indexes for custom checkout sessions, custom orders, source type/source id, and buyer id once real timings identify a bottleneck.
- Consider batching bag count refresh with source mutation responses if count refresh becomes a measurable extra round trip.
- Keep backend eligibility as the source of truth; frontend caching must remain short-lived and invalidated after mutations.
