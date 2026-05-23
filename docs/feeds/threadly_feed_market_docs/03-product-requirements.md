# Product Requirements

## Product goal

Threadly should become a social-commerce fashion discovery platform where users can browse designs, products, collections, brands, and suggestions through dynamic, personalized, fair, and emotionally engaging surfaces.

## In-scope

- Design feed personalization.
- Market home section rendering.
- Market category and section management.
- Market suggestion engine.
- View All per market section.
- Product/collection/brand suggestion blocks.
- Guest/new/returning-user rendering.
- User preference controls.
- Super admin configuration.
- Signals, analytics, and scoring.
- New-brand fairness.
- Low-cost scalable implementation.
- Legal/user reference documentation implications.

## Out of scope for V1

- ML/AI embeddings.
- Cart suggestions.
- Live shopping.
- Real-time collaborative shopping.
- Paid third-party recommendation engines.
- Expensive external analytics dependency.
- Invasive device fingerprinting.
- Full visual similarity detection.

## User types and behavior

| User type | Required behavior |
|---|---|
| Guest | Generic Explore/Fresh/Trending suggestions; no For You |
| New authenticated user | Discover default; onboarding preferences if available |
| Active authenticated user | Discover + For You + personalized sections |
| Returning buyer | Personalized commerce sections and related products |
| Brand user | Market visibility subject to product readiness and quality |
| Admin | Can manage assigned configs |
| Super admin | Full configuration and governance access |

## Success metrics

### Feed health
- feed uniqueness rate;
- repeated exposure rate;
- freshness ratio;
- category diversity;
- brand diversity;
- hidden/suppressed item rate.

### Market health
- section impression rate;
- section View All click rate;
- section engagement rate;
- product card CTR;
- wishlist rate;
- add-to-cart rate;
- checkout-start rate;
- conversion rate;
- new-brand exposure rate.

### Suggestion health
- suggestion impression rate;
- suggestion CTR;
- suggestion wishlist/cart rate;
- suggestion hide rate;
- duplicate prevention rate;
- new-brand suggestion exposure.

### Performance health
- backend response time;
- query count per surface;
- client memory usage;
- first contentful render;
- no observer/timer leaks;
- signal queue success rate.

## Acceptance criteria

- No main feed or market screen depends on loading thousands of products client-side.
- Every visible market section is backed by a section config and ranking profile.
- Every View All route uses the same section ranking profile as the preview.
- Suggestions lazy-load and never block primary content.
- Users can hide suggestion blocks/items.
- New brands have measurable reserved exposure.
- Super admin changes are audited.
- Formula changes are versioned.
