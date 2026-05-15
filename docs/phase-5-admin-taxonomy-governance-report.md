# Phase 5 Admin Taxonomy Governance Report

## Summary
Phase 5 added backend governance around taxonomy mutation, hashtag moderation, admin review metadata visibility, and drift checks. The work keeps the Phase 1/2 contract intact:

- `categoryId` remains garment category.
- `categoryTypeId` / `subCategoryId` remain garment subcategory.
- `type` / `gender` remain audience.
- `FilterDimension` / `FilterValue` / `EntityFilter` remain structured discovery metadata.
- `tags` remain hashtags.
- `visibility` remains visibility.

No database fields were renamed.

## Files Changed
- `src/categories/taxonomy-governance.ts`
- `src/categories/categories.service.ts`
- `src/categories/categories.admin.controller.ts`
- `src/categories/categories.module.ts`
- `src/categories/default-taxonomy.spec.ts`
- `src/categories/categories.service.spec.ts`
- `src/categories/suggestions/category-suggestions.admin.controller.ts`
- `src/categories/suggestions/category-suggestions.service.ts`
- `src/categories/suggestions/dto/moderate-category-suggestion.dto.ts`
- `src/tags/tags.controller.ts`
- `src/tags/tags.service.ts`
- `src/tags/tags.module.ts`
- `src/admin/catalog-metadata.helper.ts`
- `src/admin/products/admin-products.service.ts`
- `src/admin/collections/admin-collections.service.ts`
- `src/admin/designs/admin-designs.service.ts`

## Current Admin Taxonomy Capabilities
- Admins can list active/inactive garment categories.
- Admins can create, update, activate, deactivate, and delete unused garment categories.
- Admins can list, create, update, activate, and deactivate garment subcategories.
- Admins can read active discovery dimensions and filter values.
- Hashtag moderation remains under the tags module, not taxonomy.
- Category suggestion service code exists, but the current active admin UI treats category suggestions as removed/not auto-approved.

## Permission and Guard Behavior
- `admin/categories` now uses `JwtAuthGuard`, `RolesGuard`, and `AdminPermissionGuard`.
- Category reads require `taxonomy.read`.
- Category/subcategory writes require `taxonomy.write`.
- `tags/admin` read/search routes now require `tags.read`.
- Tag status, ban/unban, merge, metadata update, and reindex routes now require `tags.moderate`.
- SuperAdmin still bypasses granular permission checks through the existing guard.

## Category and Subcategory Governance Rules
- Blocked audience/style/occasion/service terms cannot be created or reactivated as garment categories or garment types.
- Blocked examples include Women, Men, Unisex, Everyone, African, Cultural, Wedding, Corporate, Casual, Luxury, Owambe, Custom, Bespoke, Ready-to-wear, Price range, and Designer location.
- Valid item-based terms such as Kaftans, Agbada, Bridal Wear, Maxi dress, Headwrap, and Handbag remain allowed.
- Active garment category names must be unique.
- Active garment type names must be unique within their parent garment category.
- New active garment categories and garment types require descriptions.
- New garment types must be created under an active parent garment category.
- Deleting a garment category now also checks product references and tells admins to deactivate instead when the category is in use.

## Discovery Dimension and Filter Value Governance
- Required dimensions remain `style`, `heritage`, `occasion`, `fabric`, `color-family`, and `fit`.
- The active seed contract test verifies these dimensions exist and apply to `COLLECTION`, `STORE_COLLECTION`, `DESIGN`, and `PRODUCT`.
- Legacy dimensions `fabric-type`, `fit-shape`, `designer-location`, and `price-range` remain outside the active seed contract.
- Runtime assignment still rejects inactive dimensions/values and dimensions that do not apply to the submitted entity type.
- This phase did not add new filter-dimension CRUD endpoints; larger admin CRUD is a future governance surface.

## Category Suggestion Behavior
- Suggestion submission and approval now reuse the blocked taxonomy term validator in the service layer.
- Approval requires a garment category description through `approvalDescription`, the original suggestion description, or an existing category description.
- Suggestion moderation service paths audit approve/reject actions through `ADMIN_TAXONOMY_SUGGESTION_MODERATE`.
- Current limitation: suggestion controllers/services are present in source but are not mounted by the active `CategoriesModule`; the current web admin panel says suggestion moderation is not active.

## Hashtag Moderation Separation
- Hashtag moderation remains in `src/tags`.
- Tag moderation does not create categories, filter dimensions, or filter values.
- Tag status, ban/unban, merge, and display-name updates now write admin audit logs through `ADMIN_TAG_MODERATE` when an actor id is available.

## Admin Product and Collection Metadata Visibility
Admin list payloads now include a `taxonomy` object for review context:

- garment category
- garment subcategory
- audience
- hashtags
- structured discovery metadata and `filterValueIds`

This was added to admin product, store collection, and design list services without changing public creator or marketplace payloads.

## Audit Log Behavior
- Category and subcategory create/update/deactivate/reactivate/delete operations call `AdminAuditService.safeLog` with `ADMIN_TAXONOMY_WRITE`.
- Category suggestion service approve/reject paths call `ADMIN_TAXONOMY_SUGGESTION_MODERATE`.
- Hashtag moderation service paths call `ADMIN_TAG_MODERATE`.
- Existing audit infrastructure was reused; no new audit-log system was introduced.

## Active-Only Taxonomy Contract Check
- `src/categories/default-taxonomy.spec.ts` now checks the required active discovery dimensions and legacy dimension exclusions.
- `src/categories/categories.service.spec.ts` now checks blocked category rejection and valid garment category creation.

## Scalability and Maintainability Observations
- Admin product/design/collection lists remain paginated and now load discovery metadata in one grouped query per page.
- Admin category listing is not paginated; acceptable for the current small MVP taxonomy, but should be paginated if the taxonomy grows.
- Category suggestion admin listing has no pagination if re-enabled.
- Dedicated filter dimension/value CRUD is not yet available; this is safer for MVP but limits governance operations to seed changes and read-only admin inspection.

## Commands Run
- `npx prisma validate` - passed.
- `npm test -- categories --runInBand` - passed, 2 suites, 11 tests.
- `npm run build` - passed.
- `npx prisma generate` - passed.

## Known Limitations
- Category suggestion controllers/services are source-present but not mounted in the active module.
- Admin UI does not yet render the new `taxonomy` object in product/design/collection review tables; backend payloads now expose it for the next UI pass.
- Filter dimension/value admin CRUD remains future work.

## Explicit Exclusions
- Feed scoring was not implemented.
- Feed rendering was not implemented.
- Recommendation logic was not implemented.
- Interaction event tracking was not implemented.
- Creator web/mobile upload flows were not changed in the backend repo.
