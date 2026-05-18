# Reviews Feature Flags

Created: 2026-05-18.

Phase 16A keeps existing product-review feature flags and adds lifecycle-specific flags.

## Lifecycle Flags

| Key | Default | Purpose |
| --- | --- | --- |
| `reviews.capture.enabled` | `true` | Enables completed-order lifecycle review submission, edit, and delete. |
| `reviews.prompt.afterCompletion.enabled` | `true` | Enables prompt creation after standard/custom order completion. |
| `reviews.publicDisplay.product.enabled` | `true` | Enables public lifecycle product review display. |
| `reviews.publicDisplay.collection.enabled` | `false` | Enables public lifecycle collection review display. Disabled by default. |
| `reviews.publicDisplay.design.enabled` | `false` | Enables public lifecycle design review display. Disabled by default. |
| `reviews.publicDisplay.brand.enabled` | `true` | Enables public lifecycle brand review summaries. |
| `reviews.moderation.required` | `false` | Creates submitted lifecycle reviews as `PENDING_MODERATION` when enabled. |

## Config

| Key | Default | Purpose |
| --- | --- | --- |
| `reviews.editWindowHours` | `24` | Fixed edit window from original review creation. Edits do not reset this window. |

## Legacy Product Review Flags

These remain unchanged for existing `/store/reviews` compatibility:

- `reviews.v1.read`
- `reviews.v1.write`
- `reviews.v1.brand-replies`
- `reviews.v1.admin-moderation`
- `reviews.v1.reminders`

Phase 16A lifecycle endpoints use the lifecycle flags above. Existing product review flags continue to gate existing product-review APIs.
