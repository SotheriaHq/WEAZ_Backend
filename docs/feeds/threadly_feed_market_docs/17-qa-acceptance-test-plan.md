# QA and Acceptance Test Plan

## Phase 0 alignment note - 2026-05-23

Phase 1 must include regression tests for:
- backend section preview endpoint pagination, category filtering, auth/anonymous behavior, and cache headers;
- backend product market category semantics, especially direct product category versus collection category membership;
- web market no longer loading the 4800-row aggregate path;
- web and mobile rendering the same section contract;
- View All using cursor-backed pagination;
- request cancellation for stale web/mobile market requests;
- patch terminology in new user-facing feed/market copy;
- non-personalized fallback behavior.

Safe commands identified during Phase 0:
- backend: `npm run build`, `npm test`, `npm run test:e2e` where environment supports DB/test services;
- web: `npm run build`, `npm run lint`, `npm run test`;
- mobile: `npm exec tsc -- --noEmit`, `npm run ci:phase8` where Expo/native dependencies and scripts are available.

## Backend API tests

### Feed
- returns Discover for new authenticated user.
- hides For You for guest.
- enables For You after threshold.
- applies suppression.
- applies seen-content dedupe.
- uses cursor pagination without duplicates.
- applies category fallback.

### Market sections
- returns active sections only.
- hides empty sections.
- applies preview item count.
- supports View All pagination.
- preserves ranking profile.
- excludes unavailable products.
- reserves new-brand slots where configured.
- avoids duplicate products across sections when required.

### Suggestions
- returns suggestions for product detail.
- returns Similar Picks and Complete the Look separately.
- excludes current product.
- excludes already visible products.
- lazy-load endpoint can fail without primary content failing.
- user can hide suggestion item.
- user can hide suggestion block.
- guest receives generic trending/fresh.

### Admin
- super admin can create/edit/publish category.
- unauthorized admin denied.
- invalid formula rejected.
- default category cannot be archived without replacement.
- audit log created for config changes.
- formula version rollback works.

### User settings
- reset feed creates reset marker.
- hidden content can be restored.
- muted brand can be restored.
- location preference disables location scoring.
- notification preferences persist.

## Web E2E tests

- Market page loads without pulling thousands of products.
- section previews render.
- View All CTA visible subtly and accessible.
- View All opens section detail and back restores scroll.
- product detail lazy-loads suggestions.
- suggestion hide removes block/item.
- no duplicate cards in main + suggestions.
- filters/categories do not break section rendering.
- search empty shows suggestions.
- component unmount cancels observers/timers.

## Mobile E2E/manual tests

- MarketScreen sections render from backend config.
- Hero/fresh/blazing/new-designer sections render.
- View All route works.
- Product detail suggestions render.
- suggestion hide works.
- guest sees generic suggestions.
- app background flushes dwell timers.
- FlatList does not duplicate rows.
- low-data test environment shows caught-up state.

## Performance tests

- market home response below agreed target.
- section detail pagination below agreed target.
- suggestions below-fold do not block main render.
- signal emission does not block UI.
- no memory growth after repeated navigation.
- no duplicate interval leaks.

## Edge-case tests

- empty market.
- less than 5 users.
- first user.
- archived category link.
- paused section link.
- product deleted after loaded.
- brand store closed.
- user logs in mid-scroll.
- location denied.
- network failure during suggestions.
- signal endpoint unavailable.
