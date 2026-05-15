# Phase 2 Backend Taxonomy Seed Validation Report

## 1. Summary Of Changes

Phase 2 cleaned the backend taxonomy seed and added service-layer validation for creator metadata.

- Top-level seeded categories are now garment/item families only.
- `categoryId` remains garment category.
- `categoryTypeId` and `subCategoryId` remain compatibility aliases for garment subcategory.
- `type` and `gender` remain audience fields.
- `FilterDimension`, `FilterValue`, and `EntityFilter` now carry structured discovery metadata.
- Tags remain hashtags/social search terms and do not replace structured metadata.
- Publish/live validation now requires structured metadata while draft saves remain flexible.

No database field names were renamed. Feed scoring, feed rendering, recommendation logic, interaction events, and market/feed UI were not implemented.

## 2. Files Changed

- `src/categories/default-taxonomy.ts`
- `src/categories/categories.service.ts`
- `src/categories/categories.service.spec.ts`
- `src/categories/default-taxonomy.spec.ts`
- `src/collections/collections.service.ts`
- `src/collections/collections.service.spec.ts`
- `src/store/store.service.ts`
- `src/store/store.service.spec.ts`
- `prisma/seed.ts`
- `docs/phase-2-backend-taxonomy-seed-validation-report.md`

`prisma/seed_brand.ts` was audited. It seeds brand dashboard orders/payouts only and does not create demo catalog taxonomy entities, so no change was needed there.

## 3. Final Top-Level Garment Categories

Seeded active categories:

1. Dresses & Gowns (`dresses-gowns`)
2. Tops & Shirts (`tops-shirts`)
3. Trousers & Shorts (`trousers-shorts`)
4. Skirts (`skirts`)
5. Suits & Blazers (`suits-blazers`)
6. Co-ord Sets (`co-ord-sets`)
7. Outerwear (`outerwear`)
8. Agbada (`agbada`)
9. Senator Wear (`senator-wear`)
10. Kaftans (`kaftans`)
11. Buba & Wrapper (`buba-wrapper`)
12. Native Sets (`native-sets`)
13. Bridal Wear (`bridal-wear`)
14. Accessories (`accessories`)
15. Footwear (`footwear`)
16. Bags (`bags`)
17. Jewelry (`jewelry`)

Women, Men, Unisex, African/Cultural, Wedding, Corporate, Casual, Luxury, Custom, Bespoke, and Ready-to-wear are not seeded as top-level garment categories.

## 4. Final Discovery Dimensions And Values

All required creator discovery dimensions apply to `COLLECTION`, `STORE_COLLECTION`, `DESIGN`, and `PRODUCT`.

- `style`: Casual / Streetwear, Formal / Corporate, Evening / Luxury, Bridal / Wedding, Minimalist, Modest, Statement / Bold, Vintage / Retro, Everyday, Contemporary.
- `heritage`: African & Cultural, Ankara, Aso Ebi, Adire, Lace, Aso Oke, Kente, Kampala, Dashiki, Yoruba Traditional, Igbo Traditional, Hausa / Arewa Traditional, Isi Agu, Coral Beads / Royal Traditional, Afro-Modern.
- `occasion`: Everyday, Office / Work, Wedding, Owambe / Party, Date Night, Religious Event, Festival / Cultural Event, Graduation, Birthday, Red Carpet, Travel / Vacation, Naming Ceremony, Traditional Ceremony.
- `fabric`: Ankara, Lace, Silk, Cotton, Linen, Denim, Chiffon, Crepe, Velvet, Aso Oke, Adire, Kente, Satin, Organza.
- `color-family`: Black, White, Neutral, Red, Blue, Green, Yellow, Pink, Purple, Brown, Gold, Silver, Multicolor, Earth Tones, Pastels.
- `fit`: Slim, Regular, Loose, Oversized, Flowy, Structured, Fitted, Relaxed.

Legacy out-of-contract dimensions `fabric-type`, `fit-shape`, `designer-location`, and `price-range` are deactivated by seed. Clean slugs were used instead of preserving `fabric-type` and `fit-shape` because the Phase 2 backend contract requires `fabric` and `fit`, and backend publish validation now treats inactive legacy values as invalid for live metadata.

## 5. Compatibility Aliases Preserved

- Existing DB fields were not renamed.
- `Collection.categoryTypeId` still represents garment subcategory.
- `Collection.subCategoryId` DTO alias still maps to `categoryTypeId`.
- `Product.categoryTypeId` still represents garment subcategory.
- Product DTO alias behavior for `subCategoryId` remains unchanged.
- Existing `EntityFilter` shape remains intact.

## 6. Legacy Category Handling

Seed deactivates legacy top-level categories instead of deleting them, preserving FK integrity:

- `womens-wear`
- `mens-wear`
- `unisex-accessories`
- `custom-bespoke`
- `african-fashion`
- `western-fashion`
- `indian-fashion`

Legacy category types are deactivated only when they are old bad slugs or live under legacy categories. Newly seeded valid garment subcategories are protected by `(categoryId, slug)` so idempotent reseeds do not deactivate valid rows.

## 7. FilterDimension.appliesTo Enforcement

`CategoriesService.setEntityFilters` now:

- Deduplicates incoming filter value IDs.
- Validates every submitted value exists.
- Validates every value is active.
- Loads and validates the related `FilterDimension`.
- Validates the dimension is active.
- Validates `FilterDimension.appliesTo` includes the submitted entity type.
- Rejects invalid input with `BadRequestException`.
- Clears filters and returns `[]` when an empty list is submitted.
- Replaces all filters for the entity only after validation succeeds.

Invalid selections now fail with: `Some selected style details are invalid for this item type.`

## 8. Publish/Live Validation Behavior

Service-layer validation was added for design-backed collections, store collections, and products.

Publish/live now requires:

- Title/name where the existing flow already requires it.
- Required media counts where the existing design/product rules require media.
- Active garment category.
- Active garment subcategory that belongs to the selected category.
- Audience through `type` or `gender`.
- At least one valid structured discovery filter.
- At least one hashtag.

Creator-facing validation messages use contract labels:

- `Choose what this item is.`
- `Choose a garment type.`
- `Choose who this item is for.`
- `Add at least one style detail.`
- `Add at least one hashtag.`

Backend field names such as `categoryTypeId`, `filterValueIds`, `EntityFilter`, and `FilterDimension` are not exposed in these user-facing publish errors.

## 9. Draft Behavior

Draft saves remain flexible:

- Drafts can still be saved without category, subcategory, structured filters, or hashtags where the existing draft UX supports that.
- If a draft explicitly submits filter IDs, `setEntityFilters` still validates them instead of silently dropping bad IDs.
- Existing stricter non-draft upload initialization behavior was not broadened in this phase.

## 10. Seed Behavior

`prisma/seed.ts` now:

- Seeds clean garment categories and garment subcategories.
- Seeds required discovery dimensions, including dedicated `heritage`.
- Deactivates legacy categories and old/out-of-contract filter dimensions.
- Deactivates obsolete values inside active seeded dimensions.
- Keeps hashtag suggestions aligned with structured metadata without making hashtags the taxonomy.
- Updates demo Design/Product/StoreCollection taxonomy from old `womens-wear` to `dresses-gowns` + `maxi-dress`.
- Seeds representative `EntityFilter` rows idempotently for demo Design, Product, and StoreCollection.

Representative demo selections include:

- Design: `style/statement-bold`, `heritage/african-cultural`, `heritage/ankara`, `occasion/owambe-party`, `fabric/ankara`, `color-family/multicolor`, `fit/regular`.
- Product: `style/bridal-wedding`, `style/statement-bold`, `heritage/ankara`, `occasion/wedding`, `fabric/ankara`, `color-family/multicolor`, `fit/regular`.
- StoreCollection: `style/evening-luxury`, `heritage/african-cultural`, `occasion/owambe-party`, `fabric/ankara`, `color-family/multicolor`, `fit/regular`.

## 11. Commands Run And Results

- `npm test -- --runInBand categories/categories.service.spec.ts categories/default-taxonomy.spec.ts collections/collections.service.spec.ts store/store.service.spec.ts`: timed out before returning useful output, so suites were rerun individually below.
- `npm test -- --runInBand categories/categories.service.spec.ts categories/default-taxonomy.spec.ts --detectOpenHandles`: passed, 8 tests.
- `npm test -- --runInBand collections/collections.service.spec.ts --detectOpenHandles`: passed, 14 tests.
- `npm test -- --runInBand store/store.service.spec.ts --detectOpenHandles`: passed, 13 tests.
- `npx prisma validate`: passed.
- `npx prisma generate`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm run seed:verify`: passed before seed; showed existing demo `DESIGN` filters were absent.
- `npm run prisma:seed`: passed; deactivated legacy categories/types/dimensions and seeded demo entity filters.
- `npm run seed:verify`: passed after seed; demo `DESIGN` `EntityFilter` count was 7.

`npm run lint` was not run because the configured script uses `--fix` across the full repository, which is broader mutation than this backend-scoped phase needs.

## 12. Tests Added Or Updated

Added:

- `src/categories/categories.service.spec.ts`
- `src/categories/default-taxonomy.spec.ts`

Updated:

- `src/collections/collections.service.spec.ts`
- `src/store/store.service.spec.ts`

Coverage added:

- Valid filters are accepted and deduplicated.
- Empty filter submission clears assignments.
- Inactive filter values are rejected before existing filters are deleted.
- Filter values whose dimensions do not apply to an entity type are rejected.
- Garment subcategory must belong to the selected category.
- Publish metadata validation fails without structured filters.
- Publish metadata validation succeeds with complete structured filters.
- Seed taxonomy does not include old audience/use-case/service top-level category slugs.

## 13. Known Limitations

- Existing databases may still contain inactive legacy categories, category types, filter dimensions, and filter values for historical FK integrity.
- Existing live catalog rows that only have old inactive filter values must be remediated before future metadata edits can pass live validation.
- `scripts/verify-fresh-db-seed.ts` counts all filter dimensions, including inactive legacy dimensions. It passed, but it is not a taxonomy-contract audit script.
- Feed and market tests in existing suites still execute as part of `collections.service.spec.ts`, but feed behavior was not changed.

## 14. Feed/Rendering/Event Exclusion Confirmation

This phase did not implement or modify feed scoring, feed rendering, recommendation logic, interaction event tracking, or market/feed UI behavior.
