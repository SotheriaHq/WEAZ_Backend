# Category Suggestions

This document explains what Category Suggestions are, why we added them, how the workflow operates (user → admin), and how to view and test the feature via API and UI.

## Why this feature exists

- Fill gaps in the category taxonomy: Brands/users can propose new categories when existing ones don’t fit.
- Keep data quality high: Suggestions are moderated by Super Admins instead of creating arbitrary categories on the fly.
- Prevent duplicates & noise: Server validates against existing categories and pending suggestions, plus applies rate limiting.

## Data model

- Enum: `CategorySuggestionStatus = PENDING | APPROVED | REJECTED`
- Model: `CollectionCategorySuggestion`
  - `id`, `name`, `slug` (unique), `description?`
  - `status` (default PENDING)
  - `proposedByUserId` (User)
  - `decisionByUserId?` (User)
  - `rejectionReason?`, `approvedCategoryId?` (CollectionCategory)
  - `decidedAt?`, `createdAt`, `updatedAt`

Notes:
- `slug` normalization: lowercase, alphanumeric-only, spaces → dashes, max 60 chars.
- Duplicate checks: against existing `CollectionCategory.slug` and PENDING suggestions with the same `slug`.
- Rate limit: ≤ 5 suggestions per user in the last 24 hours.

## API endpoints

User (JWT required):
- POST `/categories/suggestions`
  - Body: `{ name: string (2–48, alphanum+space), description?: string (<=500) }`
  - Errors: 400 duplicate (existing category or pending suggestion), 400 rate limit exceeded.
  - Returns: the created suggestion (status PENDING).
- GET `/categories/suggestions/mine`
  - Returns the current user’s suggestions with latest first.

Admin (SuperAdmin role + JWT):
- GET `/admin/categories/suggestions?status=PENDING|APPROVED|REJECTED`
  - Returns suggestions filtered by status; default is all (sorted status asc, createdAt desc).
- PATCH `/admin/categories/suggestions/:id`
  - Body: `{ decision: 'APPROVE' | 'REJECT', rejectionReason?: string }`
  - APPROVE: creates a new `CollectionCategory` if one with the same slug doesn’t already exist, then marks suggestion APPROVED.
  - REJECT: marks suggestion REJECTED and persists `rejectionReason`.

## Workflow

1) User submits
- Brand/user opens the suggestion form and enters a name (+ optional description).
- Server validates: pattern, duplicate slug, and per-user rate limit.
- Suggestion is stored with status PENDING.

2) User can view status
- `GET /categories/suggestions/mine` shows the user’s submissions and their statuses.

3) Admin moderates
- Super Admin lists PENDING suggestions and decides:
  - APPROVE: Category is created (if needed) and suggestion becomes APPROVED.
  - REJECT: Suggestion becomes REJECTED (optional reason stored).

4) Effect of approval
- Approved category is now available system-wide (active=true by default) and can be assigned to collections.

## UI integration

Frontend helpers (src/api/CategoriesSuggestionsApi.ts):
- `submitCategorySuggestion({ name, description? })`
- `listMyCategorySuggestions()`
- `adminListCategorySuggestions(status?)`
- `adminModerateCategorySuggestion(id, 'APPROVE'|'REJECT', rejectionReason?)`

Example components:
- User form: `src/components/categories/CategorySuggestionForm.tsx` – a simple form to submit suggestions.
- Admin panel: `src/components/admin/CategorySuggestionsAdminPanel.tsx` – lists & moderates suggestions.

How to view in UI:
- User side: mount `CategorySuggestionForm` where it makes sense (e.g., alongside category picker in create/edit collection screens).
- Admin side: mount `CategorySuggestionsAdminPanel` in the Super Admin dashboard (ensure the user has `Role.SuperAdmin`).

## Testing and setup tips

- Database: run Prisma migration & client generation after pulling this feature to create new tables and generated types.
  - prisma migrate: `npx prisma migrate dev --name add_category_suggestions`
  - prisma generate: `npx prisma generate`
- Auth: use a valid JWT for user endpoints; use a Super Admin JWT for admin endpoints.
- Duplicates/rate-limit: test by submitting the same name twice and by sending >5 requests within 24h from the same user.

## Future enhancements
- Debounced “is this name available?” check client-side.
- Notifications when a suggestion is approved/rejected.
- Bulk moderation and richer admin filters.
