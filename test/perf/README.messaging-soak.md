# Messaging Soak And Load Script

This script validates concurrent buyer/brand send-read behavior and bulk summary pressure.

## Prerequisites

- k6 installed
- API running locally
- Test users and order IDs provisioned

## Required environment variables

- BASE_URL (default http://localhost:3040)
- BUYER_TOKEN
- BRAND_TOKEN
- BUYER_CUSTOM_ORDER_IDS (comma-separated UUIDs)
- BRAND_CUSTOM_ORDER_IDS (comma-separated UUIDs)
- BRAND_ID

## Run

```powershell
k6 run .\test\perf\messaging-soak.k6.js `
  -e BASE_URL=http://localhost:3040 `
  -e BUYER_TOKEN=<buyer_jwt> `
  -e BRAND_TOKEN=<brand_jwt> `
  -e BUYER_CUSTOM_ORDER_IDS=<id1,id2,id3> `
  -e BRAND_CUSTOM_ORDER_IDS=<id1,id2,id3> `
  -e BRAND_ID=<brand_uuid>
```

## What this covers

- Buyer list + send loop
- Brand list + send loop
- Bulk summary endpoint pressure (buyer and brand)

## Notes

- 429 responses are considered acceptable for send requests because messaging rate limiting is enforced.
- For full production gate evidence, export k6 metrics to your observability backend and attach p95/p99 and error-rate charts.
