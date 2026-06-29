# Phase 2A: Pending Creator Tag Registration

## Decision

Custom tags use an internal `TagIndexService.registerPendingCreatorTags` path. No public tag-creation endpoint was added.

The method applies the canonical backend normalization rules, rejects banned or rejected tags, creates missing tags with `PENDING` status and `createdById`, and attributes legacy unowned pending tags. It does not replace another creator's attribution.

## Lifecycle and Privacy

Design initialize, draft update, and finalize paths register submitted tags before public tag indexing. Registration does not create `TagBinding` rows, increment usage, or change design visibility. Draft and private designs therefore remain absent from public tag feeds.

When a design becomes public and published, the existing `syncEntityTags` path creates the binding. Existing `/tags/admin` queue and `/tags/admin/status/:normalizedName` moderation remain unchanged. Tag list/search responses now include `PENDING` or `APPROVED` status so the creator UI can preserve pending treatment.

## Phase 2B Locked Rule

Delivery/production ranges must accept 1-7 days, including one day, and reject values above seven. Existing 8-14 day records need a compatibility plan. Rush remains capped at 72 hours, while removal of the 70% rush-fee cap belongs to Phase 2B.

## Files Changed

- `src/tags/tag-index.service.ts`
- `src/tags/tag-index.service.spec.ts`
- `src/tags/tags.service.ts`
- `src/tags/tags.controller.ts`
- `src/collections/collections.service.ts`

## Validation

- Focused pending-tag Jest tests
- Backend build
- Full backend Jest suite
- Diff whitespace check
