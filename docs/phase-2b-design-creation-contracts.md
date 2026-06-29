# Phase 2B — Backend Design-Creation Contracts

Date: 2026-06-20
Scope: `bthreadly` (NestJS API)

## 1. Phase 2A gate result

Phase 2A (pending creator-tag registration) was audited and verified **complete and
clean** before any Phase 2B work began. Manual commit `38ac9e9` was correctly scoped
to `src/tags/*` + `collections.service.ts` tag wiring, with no contamination. Full
Jest baseline before Phase 2B: **138 suites / 941 tests passing**.

## 2. Delivery / production range — locked to 1–7 days

Previously `deliveryMinDays` / `deliveryMaxDays` were validated `@Min(2)@Max(14)`.
(`productionLeadDays` was already `1–7`.) Phase 2B locks the delivery range to **1–7**.

- DTO: `custom-order-configurations.dto.ts` → `deliveryMinDays` / `deliveryMaxDays`
  now `@Min(1)@Max(7)`.
- Service guardrail (`validateConfigurationGuardrails`): rejects delivery values
  `< 1` or `> 7`, and `deliveryMinDays > deliveryMaxDays`.
- `1` is valid; `1–2` is accepted; anything `> 7` is rejected.

### Existing-record handling — DECISION: migrate (clamp)

Migration `20260620090000_clamp_custom_order_delivery_range_to_1_7` clamps any legacy
`CustomOrderConfiguration` rows with delivery days `> 7` down to `7` (and `< 1` up to
`1`), then re-establishes `deliveryMinDays <= deliveryMaxDays`. Version snapshot JSON
is intentionally left untouched (historical record); live rows are the source of truth
for new orders.

## 3. Rush rules — DECISION: keep days model (max 3 days = 72h)

Rush turnaround is modeled in **days** via `rushProductionLeadDays` (`@Min(1)@Max(3)`),
not hours. 3 days == 72h, so the "rush max 72h" rule is already enforced. **No new
hours field was introduced** (would have meant inventing a DTO/schema field). The
guardrail error message now documents the mapping ("max 72h").

## 4. Rush fee cap — DECISION: keep the 70% cap, surface it as a field error

The 70%-of-estimated-subtotal cap is retained (buyer-abuse protection). It is now
thrown as a **structured, field-mapped** error so web/native can render it inline.

## 5. Price validation — minPrice <= maxPrice

New `CollectionsService.assertValidPriceRange(min, max)` enforces `minPrice <= maxPrice`
whenever both are present in the same request. Wired into the design/collection
create, draft-create, update, and admin-patch price-write paths. Single-field updates
rely on the pre-existing consistent stored state.

## 6. Structured validation errors

Custom-order-config and price guardrails now throw
`BadRequestException({ message, field, code })`. Codes:

| code | field | meaning |
|---|---|---|
| `DELIVERY_RANGE_INVALID` | deliveryMin/MaxDays | delivery outside 1–7 or min>max |
| `PRODUCTION_LEAD_INVALID` | productionLeadDays | production outside 1–7 |
| `RUSH_FEE_REQUIRED` | rushFee | rush enabled without positive fee |
| `RUSH_FEE_CAP_EXCEEDED` | rushFee | rush fee above 70% of subtotal |
| `RUSH_LEAD_INVALID` | rushProductionLeadDays | rush lead outside 1–3 (72h) |
| `RUSH_LEAD_NOT_SHORTER` | rushProductionLeadDays | rush lead >= production lead |
| `PRICE_RANGE_INVALID` | maxPrice | minPrice > maxPrice |

The Nest response shape remains `{ message, field, code, statusCode, error }`, so
existing string-message clients keep working (`message` unchanged in meaning).

## 7. Tests run

- New `custom-order-configurations.guardrails.spec.ts`: delivery accepts 1, 1–2, 7;
  rejects 0, 8+, min>max; keeps 70% rush-fee cap (field-mapped); rush 3-day (72h) ok,
  4-day rejected. (8 tests)
- New `collections.price-range.spec.ts`: min<max, min==max, missing-bound skip, min>max
  field-mapped rejection. (5 tests)
- Full suite after changes: **140 suites / 954 tests passing**, build green.

## 8. Retry preservation boundary

Out of backend scope — see mobile doc. No backend changes required.

## 9. Manual QA checklist

- [ ] Create a custom-order config with delivery `1–7` → accepted.
- [ ] Attempt delivery `0` or `8` → 400 `DELIVERY_RANGE_INVALID`.
- [ ] Existing 8–14 day config after migration shows clamped `7`.
- [ ] Rush fee above 70% → 400 `RUSH_FEE_CAP_EXCEEDED` on `rushFee`.
- [ ] Collection create with minPrice > maxPrice → 400 `PRICE_RANGE_INVALID`.
