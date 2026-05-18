# Native Collection Commerce Performance

## What Is Measured

Backend logs timing in non-production or observability-enabled contexts for:

- `bagging.collection_status.duration`: collection readiness resolution for `GET /bag/sources/COLLECTION/:id/status`
- `bagging.collection_bag_all.duration`: server-side Bag All mutation duration
- `bagging.collection_bag_selected.duration`: server-side Bag Selected mutation duration

Web logs timing in dev/test or when bagging observability is enabled for:

- `web.collection_status_request.duration`
- `web.collection_bag_all_request.duration`
- `web.collection_bag_selected_request.duration`

Mobile logs timing in dev/test or when bagging observability is enabled for:

- `mobile.collection_status_request.duration`
- `mobile.collection_bag_all_request.duration`
- `mobile.collection_bag_selected_request.duration`
- `mobile.collection_viewer.initial_load.duration`
- `mobile.collection_gallery.initial_load.duration`

## Where Logs Appear

- Backend: Nest `Logger.debug`
- Web: browser/dev-test `console.debug`
- Mobile: Metro/dev-test `console.debug`

Production log spam is intentionally avoided.

## Current Slow-Point Expectations

- Collection status is the expected critical request because it loads collection metadata and product readiness in one server-computed payload.
- Mixed blocker collections may be slower than all-eligible collections because they exercise selector, fitting, stale-fitting, stock, and in-bag classification.
- Gallery initial load depends on collection status plus image resolution; image download cost is outside the API timing.

## Optimizations Implemented

- Collection status returns all product readiness in one response, avoiding frontend N+1 product-status calls.
- Collection mutations refresh collection status and My Bag count once after a successful mutation.
- No long-lived eligibility cache was added, so auth/app-foreground cache invalidation risk is avoided in this phase.
- Existing bag count refresh integration is reused instead of adding a separate collection count path.

## Optimization Candidates For Later

- Add short-lived screen-session in-flight de-duplication if runtime logs show duplicate collection status requests from route transitions.
- Add backend query batching or projection tightening if large collections make status resolution slow.
- Add CDN thumbnail selection and prefetching for gallery media if device QA shows gallery jank.
- Add real collection trending metrics before rendering Trending or Most Interacted collection sections.

## Validation Evidence

- Backend Jest collection status/mutation coverage passed in the focused bagging/store/custom-orders/reviews suite.
- Web seeded Playwright bagging regression passed with collection scenarios included: 14 passed / 0 skipped.
- Mobile TypeScript, design-system CI, and theme audit passed.
- Manual Android/iOS runtime performance QA remains NOT TESTED and is documented separately.
