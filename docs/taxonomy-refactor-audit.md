# Taxonomy Refactor Audit

Status: documentation and audit only. No runtime behavior was changed for this phase.

## Scope

This audit covers the current creator upload taxonomy and metadata implementation across backend, web, and mobile. The goal is to give a later implementation agent enough context to refactor labels, seed data, validation, and admin vocabulary without guessing.

Feed scoring, feed rendering, and interaction event tracking are excluded from this audit and must be handled separately.

## Files Inspected

### Backend: `bthreadly`

- `prisma/schema.prisma`
- `src/categories/default-taxonomy.ts`
- `src/categories/categories.service.ts`
- `src/categories/categories.public.controller.ts`
- `src/categories/categories.admin.controller.ts`
- `src/categories/suggestions/category-suggestions.service.ts`
- `src/categories/suggestions/category-suggestions.controller.ts`
- `src/collections/dto/create-collection.dto.ts`
- `src/collections/dto/update-collection.dto.ts`
- `src/collections/collections.service.ts`
- `src/store/dto/create-product.dto.ts`
- `src/store/store.service.ts`
- `src/tags/tags.controller.ts`
- `src/tags/tags.service.ts`
- `src/tags/tag-index.service.ts`
- `src/search/search.service.ts`
- `src/admin/collections/admin-collections.service.ts`
- `src/admin/products/admin-products.service.ts`
- `prisma/seed.ts`
- `prisma/seed_brand.ts`

### Web: `fthreadly`

- `src/pages/catalog/CreateDesign.tsx`
- `src/hooks/useCollectionUpload.ts`
- `src/components/categories/FilterSelector.tsx`
- `src/components/categories/filterTagSuggestions.ts`
- `src/api/collectionUploads.ts`
- `src/api/ProductApi.ts`
- `src/api/BrandApi.ts`
- `src/api/StoreApi.ts`
- `src/pages/studio/products/EditProduct.tsx`
- `src/pages/studio/store/StoreCollectionCreate.tsx`

### Mobile: `threadly-mobile`

- `app/catalog/create-design/composer.tsx`
- `src/features/design-editor/DesignEditorProvider.tsx`
- `src/api/DesignApi.ts`
- `src/features/design-editor/designCreationRules.ts`
- `components/ui/AppBottomSheet.tsx`
- `components/ui/AppSelectSheet.tsx`
- `components/ui/OptionRow.tsx`
- `components/ui/Input.tsx`
- `components/ui/Chip.tsx`
- `components/ui/Card.tsx`
- `components/ui/Button.tsx`

## Current Implementation Summary

### Backend

The backend already has the structural primitives needed for the refactor:

- `CollectionCategory` stores top-level taxonomy entries.
- `CollectionCategoryType` stores subcategory entries scoped to a category.
- `Collection`, `Design`, and `StoreCollection` use `categoryId`, `categoryTypeId`, `type`, `visibility`, and `tags`.
- `Product` uses `categoryId`, `categoryTypeId`, `gender`, and `tags`.
- `FilterDimension`, `FilterValue`, and `EntityFilter` provide structured discovery metadata for `COLLECTION`, `STORE_COLLECTION`, `PRODUCT`, and `DESIGN`.
- `CollectionCategorySuggestion` supports creator suggestions and admin moderation.
- The tags module indexes hashtags, supports moderation, and exposes popular/search/trending tag APIs.

The current DTO/API layer already supports the compatibility aliases that later phases should preserve:

- `categoryTypeId`
- `subCategoryId`
- `filterValueIds`

Backend services validate active category records and verify that a selected subcategory belongs to the selected category before create/update. `CategoriesService.setEntityFilters` replaces existing entity filters and validates that submitted filter values exist and are active.

Current seed data creates categories, subcategories, filter dimensions, filter values, tag suggestions, and demo design/product/store collection data.

### Web

The web design, product, and store collection flows already send most of the required metadata:

- `CreateDesign.tsx` collects category, subcategory, target audience, visibility, tags, filter values, fit/sizing, and custom-order fields.
- `useCollectionUpload.ts` builds upload metadata and sends both `subCategoryId` and `categoryTypeId` for compatibility.
- `collectionUploads.ts` types the same metadata contract for design/collection upload initialization and finalization.
- `EditProduct.tsx` sends `categoryId`, `subCategoryId`, `categoryTypeId`, `tags`, and `filterValueIds`.
- `StoreCollectionCreate.tsx` sends `visibility`, `type`, `categoryId`, `categoryTypeId`, `subCategoryId`, `tags`, and `filterValueIds`.
- `FilterSelector.tsx` reads backend filter dimensions and maps selected values into `filterValueIds`.

The main issue on web is not missing plumbing; it is naming, taxonomy meaning, and inconsistent dimension display.

### Mobile

The active mobile app is `threadly-mobile`. The create-design composer is already wired to the backend metadata contract:

- `DesignEditorProvider` stores `visibility`, `audience`, `categoryId`, `subCategoryId`, `tagsInput`, and `filterSelection`.
- `DesignApi.buildMetadata` sends `visibility`, `type`, `categoryId`, `subCategoryId`, `categoryTypeId`, `tags`, and `filterValueIds`.
- `getDesignCategories` calls `/categories`.
- `getDesignFilterDimensions` calls `/categories/filters`.
- Mobile filters dimensions to entries that apply to `DESIGN` or `COLLECTION`, excluding only `designer-location`.
- The composer uses shared `OptionRow`, `AppBottomSheet`, `AppSelectSheet`, `Chip`, `Input`, and `Card` components.

Mobile already follows the compact row/sheet pattern more closely than web, but labels still use legacy terms such as Category, Privacy, Audience, More options, and Tags.

## Gaps

### Taxonomy Meaning

- Current seeded top-level categories include `womens-wear`, `mens-wear`, `unisex-accessories`, and `custom-bespoke`. These violate the target contract because Women/Men/Unisex are audiences, and custom/bespoke is an availability/service model rather than a garment category.
- Current subcategory seed data includes values such as `wedding-events`, `womens-formal`, and `mens-formal`. Occasion and audience concepts should move into structured dimensions or audience fields instead of garment taxonomy.
- No dedicated `heritage` discovery dimension exists in current seed data.
- `Wedding`, `Corporate`, `Casual`, and `Luxury` appear as style/occasion/tag concepts in the current ecosystem and must not be promoted into garment categories.

### Structured Metadata

- `style`, `occasion`, `fabric-type`, `color-family`, and `fit-shape` already exist as filter dimensions, but web `FilterSelector` hides `Color Family` and `Fit / Shape`.
- Mobile shows more discovery dimensions than web because it only excludes `designer-location`. This creates inconsistent creator metadata between platforms.
- `CategoriesService.setEntityFilters` validates that filter values are active, but does not enforce the selected value's `FilterDimension.appliesTo` against the submitted entity type.
- Demo seed data creates taxonomy and tags but does not attach representative `EntityFilter` rows to demo Design/Product/StoreCollection records.
- Tags are linked to filter suggestions, but tags remain freeform social metadata. They must not become the fallback for missing structured fields.

### Creator-Facing Labels

Current web/mobile labels do not match the target naming contract:

- Category should become "What is it?"
- Sub-Category/category type should become "Garment type"
- Target Audience, Audience, Type, and Gender should become "Who is it for?"
- Filters & Attributes should become grouped discovery sections such as "Style details", "Cultural vibe", and "Where would you wear it?"
- Tags should become "Hashtags"
- Privacy/Visibility should become "Who can see this?"

### Product Audience

The backend `Product` model supports `gender` as audience, but the inspected web product edit/create flow does not expose a clear creator-facing audience selector for products. Later web work should map this to "Who is it for?" while preserving the backend `gender` field name.

### Admin Surfaces

- Admin category controllers and category suggestion moderation exist.
- Admin collection and product moderation services do not currently surface enough taxonomy context in list/detail payloads for reviewers to audit category, subcategory, audience, hashtags, and structured discovery metadata.
- Category suggestions currently approve top-level categories. Later phases should decide whether suggestions can also cover garment subcategories, discovery dimensions, or filter values.
- Admin language must preserve: Taxonomy, Garment categories, Garment subcategories, Discovery dimensions, Filter values, Hashtag moderation, Category suggestions.

### Search

- Search suggestions use names/titles, brand names, tags, descriptions, and indexed tag records.
- Structured discovery metadata is not clearly included in suggestion matching. That is acceptable for this documentation phase, but later search work should use structured metadata without turning hashtags into the source of truth.

### UI Density

- Web create-design and store-collection creation have multiple carded/bordered metadata sections and legacy labels. Later UI work should compact these forms rather than stacking more fields vertically.
- Web `FilterSelector` uses a bordered section and chip grid under the generic "Filters & Attributes" label. It needs contract-specific grouping and lighter visual treatment.
- Web product edit uses a long scrollable metadata column and hides scrollbars. The new standard prefers thin rounded scrollbars where custom scrollbars exist.
- Mobile already uses row-based metadata and bottom sheets, but `Card`, `Input`, and sheet option cards still use full borders in several advanced sections. Later work should preserve compactness and avoid increasing screen height.

## Risks

- If audience remains encoded in categories, discovery, search, and admin moderation will classify the same garment inconsistently across platforms.
- If occasion/style/luxury language is treated as category data, creators will be forced into incorrect item families and later feed/search logic will inherit bad metadata.
- If hashtags are used to compensate for missing structured metadata, Threadly will lose reliable filtering, moderation, analytics, and future personalization inputs.
- If web and mobile continue showing different discovery dimensions, uploads from different platforms will not be comparable.
- If `FilterDimension.appliesTo` is not enforced during write operations, invalid structured metadata can be attached to the wrong entity type.
- If database fields are renamed during this refactor, current web/mobile/backend clients and compatibility aliases may break. Field renaming is not part of this plan.
- If admin moderation screens do not show taxonomy context, admins cannot reliably catch bad category/subcategory/audience choices before MVP.
- If feed work starts before taxonomy cleanup, feed scoring and rendering may encode the wrong meaning. Feed phases are explicitly excluded until this contract is implemented.

## Later Phase Checklist

### Backend

- Preserve existing database field names and API aliases.
- Replace or migrate default category seed data so top-level categories are garment item families.
- Reclassify audience, occasion, style, heritage, fabric, color family, and fit into the correct fields/dimensions.
- Add a dedicated `heritage` `FilterDimension`.
- Ensure `FilterDimension.appliesTo` is enforced when assigning `EntityFilter` records.
- Keep `subCategoryId` and `categoryTypeId` aliases during web/mobile compatibility.
- Add representative demo `EntityFilter` rows to seed data.
- Ensure admin collection/product review payloads include category, subcategory, audience, hashtags, and structured discovery metadata.
- Decide whether category suggestions should support subcategories and discovery values in addition to top-level categories.
- Keep hashtag moderation separate from taxonomy management.

### Web

- Update creator labels to the naming map in `taxonomy-and-creator-metadata-contract.md`.
- Stop presenting Women/Men/Unisex as garment categories.
- Stop presenting Wedding/Corporate/Casual/Luxury as garment categories.
- Show contract-required dimensions consistently, including color family and fit where applicable.
- Add or expose Product audience as "Who is it for?" mapped to backend `Product.gender`.
- Replace generic "Filters & Attributes" copy with grouped discovery labels.
- Keep metadata forms compact with lighter separators, compact chips, info icons/tooltips, and collapsible advanced sections.
- Remove or guard hardcoded category fallbacks that can diverge from backend taxonomy.

### Mobile

- Update composer labels to the naming map in `taxonomy-and-creator-metadata-contract.md`.
- Keep existing `DesignApi` field mapping unless a separate API migration is approved.
- Align displayed discovery dimensions with web and backend contract.
- Preserve the compact row and bottom-sheet interaction pattern.
- Move advanced discovery/custom-order fields into sections that do not increase the main composer height.
- Keep tags labeled as "Hashtags" and keep them separate from structured metadata.

### QA And Validation

- Validate Prisma schema after backend changes.
- Add or update backend tests for category/subcategory validation and `FilterDimension.appliesTo` enforcement.
- Add web/mobile contract tests for label mapping and payload fields.
- Manually QA creator upload flows on web and mobile for new users, authenticated users, empty taxonomy states, and slow-loading taxonomy endpoints.
- Verify that existing draft and published records still load with legacy field names.
- Verify admin taxonomy screens preserve the required language.

## Validation For This Phase

- Runtime code was not changed.
- Database fields were not renamed.
- Feed scoring was not implemented.
- Feed rendering was not implemented.
- Interaction event tracking was not implemented.
- Contract and audit documentation are specific enough for a later implementation agent to proceed without guessing at field meaning.
