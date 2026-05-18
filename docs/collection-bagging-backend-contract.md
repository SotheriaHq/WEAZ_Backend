# Collection Bagging Backend Contract

## Scope

Collection bagging uses `StoreCollection`, not the design/catalog `Collection` and not `Design`.

A collection is not a purchasable line item. Bagging a collection means bagging eligible products inside that `StoreCollection` through the same standard product validation rules used by individual product bagging.

## Data Model

- Store collection: `StoreCollection`
- Product link: `StoreCollectionProduct`
- Product entity: `Product`
- User bag rows: `CartItem`
- Collection owner: `StoreCollection.ownerId`

Legacy design/catalog collections remain separate and must not be treated as commerce collections.

## Readiness Endpoint

`GET /bag/sources/COLLECTION/:collectionId/status`

The response is server-computed and includes both collection-level and product-level readiness. Frontend and mobile clients must not guess whether a collection or product is baggable.

```json
{
  "sourceType": "COLLECTION",
  "sourceId": "collection-id",
  "collection": {
    "id": "collection-id",
    "title": "Collection title",
    "description": "Optional description",
    "brandId": "brand-or-owner-id",
    "brandName": "Brand name",
    "coverImage": "https://example.test/image.jpg",
    "coverImageId": null,
    "productCount": 3,
    "priceRange": {
      "min": 12000,
      "max": 45000,
      "currency": "NGN"
    }
  },
  "summary": {
    "canBagAll": true,
    "canBagSelected": true,
    "eligibleCount": 3,
    "blockedCount": 0,
    "alreadyInBagCount": 0,
    "requiresSelectionCount": 0,
    "requiresFittingsCount": 0,
    "staleFittingsCount": 0,
    "outOfStockCount": 0,
    "totalPrice": 57000,
    "currency": "NGN"
  },
  "products": [
    {
      "productId": "product-id",
      "name": "Product name",
      "coverImage": "https://example.test/product.jpg",
      "coverImageId": null,
      "price": 15000,
      "currency": "NGN",
      "canBag": true,
      "inBag": false,
      "reason": null,
      "stockState": "IN_STOCK",
      "defaultAction": "ADD_STANDARD",
      "requiresSize": false,
      "requiresColor": false,
      "availableSizes": [],
      "availableColors": [],
      "requiredMeasurementKeys": [],
      "missingMeasurementKeys": [],
      "freshnessState": "NOT_REQUIRED",
      "sourceStatus": {}
    }
  ],
  "ui": {
    "defaultAction": "BAG_ALL",
    "disabledReason": null
  },
  "featureFlags": {
    "collectionReviewsEnabled": false
  }
}
```

Allowed product `defaultAction` values:

- `ADD_STANDARD`
- `OPEN_SELECTOR`
- `OPEN_FITTINGS`
- `CONFIRM_STALE_FITTINGS`
- `OPEN_CUSTOM_FLOW`
- `DISABLED`
- `ALREADY_IN_BAG`

Allowed collection `ui.defaultAction` values:

- `BAG_ALL`
- `BAG_SELECTED`
- `RESOLVE_BLOCKERS`
- `AUTH_REQUIRED`
- `DISABLED`

## Mutation Endpoints

`POST /bag/collections/:collectionId/bag-all`

```json
{
  "acknowledgements": {
    "staleFittingsAccepted": true
  }
}
```

`POST /bag/collections/:collectionId/bag-selected`

```json
{
  "productIds": ["product-id-1", "product-id-2"],
  "selections": {
    "product-id-1": {
      "selectedSize": "M",
      "selectedColor": "Black",
      "quantity": 1
    }
  },
  "acknowledgements": {
    "staleFittingsAccepted": true
  }
}
```

Mutation response:

```json
{
  "collectionId": "collection-id",
  "added": [
    {
      "productId": "product-id",
      "bagItemId": "bag-item-id",
      "quantity": 1
    }
  ],
  "skipped": [
    {
      "productId": "product-id",
      "reason": "ALREADY_IN_BAG"
    }
  ],
  "blocked": [
    {
      "productId": "product-id",
      "reason": "MISSING_FITTINGS",
      "missingMeasurementKeys": ["WOMEN_BUST", "WOMEN_WAIST"]
    }
  ],
  "summary": {
    "addedCount": 1,
    "skippedCount": 1,
    "blockedCount": 0,
    "combinedBagCount": 4
  }
}
```

## Rules

- Bag All validates every linked product server-side.
- Bag Selected validates only selected product IDs server-side.
- Already-in-bag products are skipped, not duplicated.
- Blocked selected products prevent invalid mutation and return structured blocker rows.
- Out-of-stock products cannot be bagged.
- Missing required size/color returns selector state and blocks mutation until selections are supplied.
- Missing fittings returns fitting state and blocks mutation until requirements are satisfied.
- Stale fitting flows require acknowledgement where the product flow requires it.
- Own-brand collection bagging is blocked.
- Mutations require authentication through `JwtAuthGuard`.
- Standard bag rows are written transactionally after blocker detection.
- Checkout, payment, settlement, ledger, and payout behavior are unchanged.
- Collection/design public reviews remain hidden unless feature flags explicitly allow them.

## Seeded E2E Data

`scripts/seed-bagging-e2e.ts` writes these collection values to `../fthreadly/.env.e2e.bagging`:

- `THREADLY_E2E_COLLECTION_ALL_ELIGIBLE_ID`
- `THREADLY_E2E_COLLECTION_ALL_ELIGIBLE_PATH`
- `THREADLY_E2E_COLLECTION_MIXED_ID`
- `THREADLY_E2E_COLLECTION_MIXED_PATH`
- `THREADLY_E2E_COLLECTION_ALREADY_IN_BAG_ID`
- `THREADLY_E2E_COLLECTION_ALREADY_IN_BAG_PATH`
- `THREADLY_E2E_COLLECTION_GALLERY_ID`
- `THREADLY_E2E_COLLECTION_GALLERY_PATH`

## Client Contract Notes

- Web/mobile collection clients must call `/bag/sources/COLLECTION/:id/status` before rendering collection bag readiness.
- Web/mobile collection clients must use `/bag/collections/:id/bag-all` and `/bag/collections/:id/bag-selected` for collection mutations.
- Clients must not call `/store/cart` directly for COLLECTION or DESIGN sources.
- Clients must not call product status endpoints per product when collection status already contains product readiness.
