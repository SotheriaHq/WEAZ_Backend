# Native Market Viewer Performance

Phase 15 uses the Phase 14 timing hooks to reduce duplicate mobile bagging requests without changing backend eligibility rules.

## What Is Measured

- Backend product/source eligibility resolution through `BagEligibilityService`.
- Backend `/bag/count` presentation through `BagCountPresenter`.
- Mobile `/store/products/:id/bag-status` request duration in `MobileStoreApi.getProductBagStatus`.
- Mobile `/bag/sources/:sourceType/:sourceId/status` request duration in `MobileStoreApi.getSourceBagStatus`.
- Mobile `/bag/count` request duration in `MobileStoreApi.getBagCount`.
- Native commerce viewer initial load duration.
- Native commerce viewer Bag It action duration from tap to backend-directed flow/mutation result.

## Where Logs Appear

- Backend: Nest debug logs under bagging service/presenter contexts.
- Mobile: Metro or device debug console through `console.debug('[bagging:timing]', ...)`.
- Logs are emitted only in development/test or when `EXPO_PUBLIC_BAGGING_OBSERVABILITY=true`.

## Confirmed Slow/Duplicate Points

- Product viewer initial load previously fetched product detail and product bag status on every mount without any screen-session cache.
- Market Bag It called the hook action and then refreshed global bag count again, even though successful mutations already refresh bag state.
- `useMobileBagging.prepareBag` and `prepareSourceBag` made duplicate in-flight status requests when a viewer and action path asked for the same status together.
- `BagCountContext.refreshGlobalBagCount` allowed concurrent `/bag/count` requests when route focus, mutation completion, or foreground refresh overlapped.

## Changes Made

- Added mobile product bag-status timing.
- Added mobile bag-count timing.
- Added short-lived in-memory bag-status cache with an 8 second TTL.
- Added in-flight de-duplication for product/source bag-status requests.
- Invalidated status cache on auth state change, app foreground, and after standard/custom bag mutations.
- Added in-flight de-duplication for global bag-count refreshes.
- Removed the extra Market-screen count refresh after Bag It, leaving mutation paths to refresh count once.

## Before/After Notes

- Before: repeated viewer load and Bag It paths could issue duplicate status and count requests for the same source.
- After: concurrent requests share the same promise, cached eligibility is short-lived, and mutations force a fresh backend status read.
- No long-lived eligibility cache was added; backend remains the source of truth.
- No checkout, payment, settlement, ledger, or payout behavior changed.

## Remaining Optimization Candidates

- Capture real p50/p95 timings on Android and iOS device sessions.
- Add request tracing IDs if backend/mobile logs need exact tap-to-response correlation.
- Review backend indexes only after real timing logs identify a database bottleneck.
- Consider including updated bag count in mutation responses if count refresh remains a measured extra round trip.
