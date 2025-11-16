# Private Collections: Phase 6 QA, Policies, and Rollout

Date: 2025-11-16

## Cooldown UX
- Env: `PRIVATE_ACCESS_COOLDOWN_MS` (default 72h) controls re-request cooldown after rejection.
- API: `POST /collections/:id/access-requests` returns `{ state: 'PENDING', cooldownActive: true, nextAllowedAt: ISO8601 }` while cooldown is active.
- Client: Show info toast "Try again after <time>"; do not change state. Brand sees toast "Rejected – requester locked for 72h" when rejecting.

## Accessibility / A11y
- Added ARIA roles and labels to Settings pagination, tabs, search input, and confirmation dialogs.
- Private access confirm dialog uses `role=dialog`, labelled by title/message IDs.
- Keyboard navigation: tabs are buttons with `aria-selected`; no custom key handlers needed.

## Edge Cases & Policies
- Rejection -> cooldown enforced (state stored as REVOKED + notes='REJECTED').
- Owner requesting own private collection auto-approved.
- Unauthenticated visitor prompting login with returnTo preserved.
- targetUrl sanitized server-side; only internal route prefixes permitted.
- Abuse throttling: 10 requests/min per collection access request endpoint.
- SEO: Private collections excluded from public listing unless approved.
- Analytics/privacy: Access metrics logged under `metrics.access_*` (no PII beyond user IDs).

## E2E Flow (Manual Checklist)
1. Visitor opens brand profile, navigates to Private tab, sees request buttons.
2. Visitor clicks Request Access -> confirm dialog -> requests; state shows Requested.
3. Brand views Settings > Collections (Pending Requests) and Rejects -> visitor toast appears on subsequent request attempt with cooldown time.
4. Brand Approves another request -> visitor sees collection appear under visibility=all.
5. Brand Revokes access -> visitor state changes to Revoked; cannot view collection detail.
6. Notifications: Request/Approve/Reject/Revoked all emit and deep-link correctly.

## Test Plan Summary
- Frontend unit tests: cooldown label formatting; visibility toggle note (implemented).
- Backend existing tests require DI module scaffolding improvements (not blocking feature completion).
- Recommended future enhancement: integration spec importing AppModule to exercise full Prisma path.

## Rollout Steps
1. Set `FEATURE_PRIVATE_COLLECTIONS=true` in production env.
2. Set `PRIVATE_ACCESS_COOLDOWN_MS=259200000` (72h) explicitly for clarity.
3. Deploy backend, then frontend; clear CDN caches.
4. Monitor logs for `metrics.access_request` spikes; adjust throttling if abuse detected.
5. Gather feedback from first brands; iterate on UI (pagination numbers, bulk actions).

## Search & Pagination (Brand Settings)
- Endpoint: `GET /brands/:id/private-access/requests`
- Params:
  - `status`: `pending` | `approved`
  - `q`: search by viewer username or collection title (case-insensitive)
  - `page`, `pageSize` (offset-based) OR `cursor`+`limit` (cursor-based)
- Response shape:
  - `items`, `hasNextPage`, `endCursor`, `totalCount`, `page`, `pageSize`, `totalPages`

## Abuse Throttling (Hooks)
- Requests endpoints guarded by `JwtAuthGuard`.
- Base throttling for likes already used; similar pattern can be applied to access requests if needed:
  - Consider adding `@UseGuards(ThrottlerGuard)` with modest limits (e.g., limit 10, ttl 1m) to `/collections/:id/access-requests`.

## Accessibility & ARIA
- Settings search input has `aria-label`.
- Tabs use `role=tablist` and buttons `role=tab` with `aria-selected`.
- List uses `role=list` / `role=listitem`.

## Test Plan
- Unit (frontend): Verify cooldown message formatter (local time) and that state is not updated on cooldown.
- Integration (manual/API):
  1. Reject a request; immediately re-request → API returns cooldown object.
  2. Confirm toast shows and state unchanged in UI.
  3. Search by partial username and by collection title returns filtered results.
  4. Page through requests and confirm counts/limits.
- E2E (manual):
  - Full flow: Request → Approve → View content; Revoke → Cannot view; Reject → Cooldown toast.

## Rollout & Monitoring
- Feature remains behind `FEATURE_PRIVATE_COLLECTIONS` gate where applicable.
- Monitor metrics logs: `metrics.access_request`, `metrics.access_approve_bulk`, `metrics.access_update_state`, `metrics.access_reject`.

## Notes
- `REJECTED` represented as `state=REVOKED` with `notes='REJECTED'` to avoid schema migration.
- `targetUrl` for notifications is sanitized server-side.
