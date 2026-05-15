# Taxonomy And Creator Metadata Contract

Status: documentation contract for the taxonomy refactor. This file defines the intended architecture and naming standard. It does not rename database fields and does not change runtime behavior.

## Scope

This contract covers creator upload taxonomy and structured metadata for Designs, Collections, StoreCollections, and Products. It is the implementation guide for later backend, web, and mobile phases.

Feed scoring, feed rendering, and interaction event tracking are intentionally out of scope for this plan. Those phases must not be implemented as part of this taxonomy refactor.

## Non-Negotiable Classification Rules

- African/Cultural is not an audience.
- Women/Men/Unisex are not garment categories.
- Wedding/Corporate/Casual/Luxury are not garment categories.
- Tags/hashtags must not replace structured metadata.
- Feed scoring and feed rendering are intentionally out of scope for this plan.

## Internal Architecture

### Garment Category

A garment category is the top-level physical item family. It answers the internal question: what broad kind of garment or fashion item is this?

Garment categories must be item families, not audience, occasion, style, price tier, culture, or marketing language.

Valid direction examples:

- Dresses
- Tops
- Bottoms
- Outerwear
- Traditional sets
- Accessories
- Footwear

Invalid garment category examples:

- Women
- Men
- Unisex
- African
- Cultural
- Wedding
- Corporate
- Casual
- Luxury

Current field mapping:

- `Collection.categoryId`
- `Design.categoryId`
- `StoreCollection.categoryId`
- `Product.categoryId`

### Garment Subcategory

A garment subcategory is the specific garment type under a garment category. It answers: what exact garment type is this?

Examples:

- Dress
- Gown
- Kaftan
- Agbada
- Blouse
- Shirt
- Trousers
- Skirt
- Headwrap
- Bag
- Shoe

Current field mapping:

- `Collection.categoryTypeId`
- `Collection.subCategoryId` API alias
- `Design.categoryTypeId`
- `Design.subCategoryId` API alias
- `StoreCollection.categoryTypeId`
- `StoreCollection.subCategoryId` API alias
- `Product.categoryTypeId`
- `Product.subCategoryId` API alias

### Audience

Audience is who the garment is for. It is not the garment itself and must not be modeled as a category.

Current persisted values:

- `FEMALE`
- `MALE`
- `EVERYBODY`

Current field mapping:

- `Collection.type`
- `Design.type`
- `StoreCollection.type`
- `Product.gender`

The creator-facing label for this concept is "Who is it for?"

### Style

Style is a structured discovery dimension. It describes aesthetic details, not item category or audience.

Current direction:

- Backed by `FilterDimension` with slug `style`
- Values are backed by `FilterValue`
- Entity assignments are backed by `EntityFilter`

Creator-facing label: "Style details"

### Heritage

Heritage is a structured discovery dimension for cultural inspiration or influence. It must not be treated as audience and must not be stored only as hashtags.

Current state:

- The intended architecture requires a `heritage` discovery dimension.
- The current seed data does not provide a dedicated `heritage` `FilterDimension`.

Creator-facing label: "Cultural vibe"

### Occasion

Occasion is a structured discovery dimension for where or when an item would be worn. It must not be treated as a garment category.

Current direction:

- Backed by `FilterDimension` with slug `occasion`
- Values are backed by `FilterValue`
- Entity assignments are backed by `EntityFilter`

Creator-facing label: "Where would you wear it?"

### Fabric

Fabric is a structured discovery dimension describing material.

Current direction:

- Backed by `FilterDimension` with current slug `fabric-type`
- Values are backed by `FilterValue`
- Entity assignments are backed by `EntityFilter`

### Color Family

Color family is a structured discovery dimension describing the broad color group. It is not a hashtag-only concern.

Current direction:

- Backed by `FilterDimension` with current slug `color-family`
- Values are backed by `FilterValue`
- Entity assignments are backed by `EntityFilter`

### Fit

Fit has two related but separate meanings:

- Discovery fit: broad shape or silhouette used for browse/search filtering.
- Operational fit/custom-order fit: sizing and measurement preferences used for custom orders.

Current direction:

- Discovery fit is backed by `FilterDimension` with current slug `fit-shape`.
- Operational fit is backed by fields such as `fitPreference`, `sizingMode`, `customOrderEnabled`, and `customMeasurementKeys`.

Later implementation must keep these meanings separate. Do not replace operational custom-order fields with discovery metadata.

### Hashtags

Hashtags are creator-entered tags used for social discovery, tag feeds, moderation, and lightweight search.

Current field mapping:

- `Collection.tags`
- `Design.tags`
- `StoreCollection.tags`
- `Product.tags`
- `Tag` and tag binding records managed by the tags module

Hashtags are not the source of truth for category, subcategory, audience, style, heritage, occasion, fabric, color family, or fit.

Creator-facing label: "Hashtags"

### Visibility

Visibility controls who can see an uploaded entity. It is separate from taxonomy and discovery metadata.

Current field mapping:

- `Collection.visibility`
- `Design.visibility`
- `StoreCollection.visibility`

Current persisted values:

- `PUBLIC`
- `PRIVATE`

Creator-facing label: "Who can see this?"

### Admin Taxonomy

Admin taxonomy is the managed system of garment categories, garment subcategories, discovery dimensions, filter values, hashtag moderation, and category suggestions.

Admin taxonomy owns the canonical vocabulary. Creator upload forms consume this vocabulary; they must not invent independent category lists.

## Current Code Mapping

| Current code field | Contract meaning |
| --- | --- |
| `Collection.categoryId` | Garment category |
| `Collection.categoryTypeId` / `Collection.subCategoryId` | Garment subcategory |
| `Collection.type` | Audience |
| `Collection.tags` | Hashtags |
| `Product.categoryId` | Garment category |
| `Product.categoryTypeId` / `Product.subCategoryId` | Garment subcategory |
| `Product.gender` | Audience |
| `Product.tags` | Hashtags |
| `FilterDimension` / `FilterValue` / `EntityFilter` | Structured discovery metadata |

Adjacent model mappings already present in the codebase:

| Current code field | Contract meaning |
| --- | --- |
| `Design.categoryId` | Garment category |
| `Design.categoryTypeId` / `Design.subCategoryId` | Garment subcategory |
| `Design.type` | Audience |
| `Design.tags` | Hashtags |
| `StoreCollection.categoryId` | Garment category |
| `StoreCollection.categoryTypeId` / `StoreCollection.subCategoryId` | Garment subcategory |
| `StoreCollection.type` | Audience |
| `StoreCollection.tags` | Hashtags |

Database and API field names remain unchanged in this refactor. Later phases should change UI labels, seed data, validation, admin copy, and mapping code without renaming the existing database fields.

## Creator-Facing Naming Map

| Internal field or dimension | Creator-facing label |
| --- | --- |
| `category` / `categoryId` | "What is it?" |
| `categoryType` / `subcategory` / `categoryTypeId` / `subCategoryId` | "Garment type" |
| `type` / `gender` / `audience` | "Who is it for?" |
| `style` dimension | "Style details" |
| `heritage` dimension | "Cultural vibe" |
| `occasion` dimension | "Where would you wear it?" |
| `tags` | "Hashtags" |
| `visibility` | "Who can see this?" |

Implementation note: keep internal names as-is in TypeScript types and backend DTOs unless a separate database/API migration is explicitly approved. This phase standardizes meaning and UI labels, not field names.

## Admin-Facing Naming Map

Admin surfaces must preserve this language:

| Admin concept | Admin-facing label |
| --- | --- |
| Overall taxonomy area | Taxonomy |
| Top-level item families | Garment categories |
| Specific garment types | Garment subcategories |
| Structured metadata groups | Discovery dimensions |
| Structured metadata options | Filter values |
| Tag review and enforcement | Hashtag moderation |
| Creator-proposed category entries | Category suggestions |

## UI Standard For Metadata Forms

Creator metadata forms must remain compact. Adding structured metadata must not make upload screens feel taller or heavier.

Standards:

- Forms must be compact.
- Avoid heavy full borders around every field.
- Prefer bottom dividers and low-opacity separators.
- Keep metadata rows similar in height.
- Reduce vertical gaps.
- Use compact chips.
- Move advanced fields into collapsible sections.
- Use info icons/tooltips for descriptions.
- Use very thin rounded scrollbars where custom scrollbars exist.
- Avoid visible scrollbar arrow buttons where possible.
- Do not increase screen height unnecessarily when adding metadata.

Applied interpretation:

- Primary upload metadata should use short rows or grouped sections, not a long stack of full bordered inputs.
- Discovery dimensions such as style, heritage, occasion, fabric, color family, and fit should use compact chips.
- Advanced or less frequently edited metadata should live inside collapsible sections or sheets.
- Descriptive helper text should be hidden behind info icons/tooltips where practical.
- Web custom scrollbars should be thin and rounded. Native mobile scroll indicators can stay platform-standard unless a custom scrollbar is introduced.

## Later Phase Implementation Rules

- Do not rename `categoryId`, `categoryTypeId`, `subCategoryId`, `type`, `gender`, `tags`, or `filterValueIds` as part of this refactor.
- Do not remove existing feature coverage to make the taxonomy simpler.
- Do not implement feed scoring, feed rendering, or interaction event tracking in the taxonomy phase.
- Do not use hashtags as a substitute for missing structured metadata.
- Add missing structured metadata through `FilterDimension`, `FilterValue`, and `EntityFilter`.
- Preserve legacy API aliases where they are still consumed by web or mobile clients.
- Any seed cleanup must preserve local development usability and must be documented before destructive data changes.
