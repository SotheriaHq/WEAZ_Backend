# Fashion Social-Commerce Platform — Implementation Plan

## 1. Assumptions & Context
- Team size assumptions: 6–8 backend engineers (NestJS/Prisma), 6–8 frontend engineers (React/Vite), 2–3 mobile (future), 2 data/ML, 2 DevOps/SRE, 1–2 QA, 1 security. Two squads can work in parallel after core services exist.
- Architecture assumptions: Service-oriented but not fully microservices; shared auth/user service; separate domains for store/catalog, checkout/payments, trust/safety, creator/affiliate, notifications, analytics. Backend stack: NestJS + Prisma + PostgreSQL; Redis for caching/rate limits; WebSocket gateway; S3-compatible object storage. Frontend: React + Vite + Tailwind; native mobile later. Message bus (Kafka or SQS/SNS) for events; feature flags via LaunchDarkly/ConfigCat. Infrastructure: Kubernetes on cloud; Nigeria region primary; CDN for media.
- Constraints: Launch Nigeria-first; must handle regional payments (cards, bank transfer, USSD, mobile money); latency budget <300ms p95 for read APIs in-region; strong compliance (KYC/AML, PSD2/SCA where applicable); scale to first 1M users, 10k concurrent shoppers during drops. Uptime target 99.9% for public APIs.

## 2. System Decomposition
- Auth & Identity: account creation, login, MFA, sessions, roles/claims, impersonation for support.
- User Profile & Preferences: notification preferences, size profiles, privacy settings, loyalty linkage.
- Store Management: store creation, onboarding, media assets, status lifecycle, brand verification.
- Catalog (Products/Variants/Collections/Looks): CRUD, lifecycle states, media, pricing, inventory integrity, slug history, reservations.
- Checkout & Payments: cart, pricing engine, taxes/fees, payment orchestration (cards, bank transfer, USSD, mobile money, BNPL future), refunds, settlements, ledgers.
- Shipping & Fulfillment: address handling, shipping options, delivery estimates, exceptions/returns/exchanges.
- Loyalty & Retention: points, tiers, expiry, rewards, streaks, campaigns.
- Trust, Safety & Moderation: review queues, policy enforcement, abuse controls, takedowns, audits.
- Creator & Affiliate: creator onboarding, verification tiers, storefronts, affiliate links/codes, analytics.
- Social Graph & Engagement: follows, likes, wishlists, boards, activity feeds.
- Notifications & Communication: email/push (now), SMS behind flag; routing rules per preference; templates.
- Analytics & Experimentation: event taxonomy, exposure logging, holdouts, consent-aware pipelines.
- AI/ML: size recommendations, visual search scaffold, trend prediction, content safety signals; offline training jobs.
- Observability & Ops: logging, metrics, tracing, alerting, runbooks; rate limits and quotas.

## 3. Implementation Roadmap (PRIORITIZED)

### Plan 1: Identity, Auth, Roles, Support Impersonation
**Priority:** P0  
**Why this exists:** Foundation for every user flow; required for security, role gating (brand/admin/moderator/support), and notification routing.

**What is included:** Session-based + token auth, MFA hooks, password reset, roles/claims model, support impersonation (read-only), audit logs for auth events, rate limits.

**What is explicitly excluded (for now):** Social login, hardware key WebAuthn, org-level SSO.

**Dependencies:** None (platform root). Needed by all other plans.

**Risks & Edge Cases:** ⚠️ Session fixation and token theft; ⚠️ privilege escalation via impersonation; ⚠️ SMS/email deliverability for MFA; account lockouts and recovery.

**Success Criteria:** Roles enforce access per endpoint; audit trails for login/reset/impersonation; p95 auth <150ms; lockout/limit rules verified.

#### Tasks Breakdown

##### Task 1.1: Role/Claim Model & Migration
- Description: Add roles (USER, BRAND_OWNER, BRAND_ADMIN, CREATOR, MODERATOR, SUPPORT), claims for feature flags and brand scoping.
- Why: Enables authorization decisions across services.
- Inputs: Prisma schema, migration tooling, existing users table.
- Outputs: DB migration, seed for default roles, Prisma client types.
- Failure cases: Missing indexes causing slow ACL checks; incorrect defaults granting broad access.
- Validation: Migration tests, seed idempotence, unit tests for role resolution.

##### Task 1.2: Auth Service (login/register/reset/MFA hooks)
- Description: Implement endpoints, password hashing, session tokens/JWT, refresh rotation, reset flows, optional MFA stub.
- Why: Core authentication.
- Inputs: Email service, Redis for session blacklist, env secrets.
- Outputs: /auth/login, /auth/register, /auth/refresh, /auth/reset; tokens with exp/iat/jti.
- Failure cases: Replay without jti checks; weak password policy; email spoofing.
- Validation: Integration tests for flows, rate limit tests, token revocation tests.

##### Task 1.3: Impersonation (Support)
- Description: Add audited impersonation with scoped read-only access.
- Why: Support troubleshooting.
- Inputs: Support role, audit log sink.
- Outputs: /support/impersonate start/stop; audit events with actor/target/time.
- Failure cases: Privilege escalation to write; missing expiry.
- Validation: E2E for start/stop, ensure write endpoints reject impersonated sessions.

##### Task 1.4: Authorization Middleware
- Description: Central guard for roles/claims per route; ownership checks for brand/store resources.
- Why: Consistent enforcement.
- Inputs: Role map, route metadata, store/brand ownership lookup.
- Outputs: Nest guards/interceptors; shared library for services.
- Failure cases: Bypass on websocket/event paths; caching stale ownership.
- Validation: Unit + contract tests; negative tests for unauthorized access.

### Plan 2: Store Onboarding & Catalog Foundations
**Priority:** P0  
**Why this exists:** Core revenue surface: stores, products, variants, collections, looks; gating publish; media and slug rules.

**What is included:** Store creation wizard, status lifecycle, slug availability/reservation, media upload (S3 presign), product/variant CRUD with required fields, collections and looks CRUD, categories, type/visibility, slug history, inventory integrity, orphan prevention, soft delete, redirect rules, readiness checklist, response time SLA display.

**What is explicitly excluded:** Full AI media checks (stub only), global SKU registry, external ERP sync (future), mobile clients.

**Dependencies:** Plan 1 (auth/roles). Requires storage bucket, CDN config.

**Risks & Edge Cases:** ⚠️ Slug collisions during concurrent creates; ⚠️ media upload abuse; ⚠️ orphaned variants/media; ⚠️ draft leakage of private media URLs.

**Success Criteria:** Stores can reach PENDING_REVIEW with validations; products meet required media/fields; variants non-orphan; slugs unique with history; cover/redirects work; latency <300ms p95 for reads.

#### Tasks Breakdown

##### Task 2.1: Store Model & Lifecycle
- Description: Implement store schema (status DRAFT/PENDING_REVIEW/LIVE/ON_BREAK/SUSPENDED), slug reservation, responseTimeSLA, verification flag, social links.
- Why: Foundation for brand presence.
- Inputs: Requirements doc, Prisma schema, migrations.
- Outputs: Tables, indexes on slug/status/ownerId; API for create/update/status transitions.
- Failure cases: Duplicate slug; publish without prerequisites.
- Validation: Unit tests for transitions; slug reservation expiry tests.

##### Task 2.2: Media Upload & Validation
- Description: Presigned upload endpoints; enforce min resolution; track media metadata; mark required shots.
- Why: Media quality enforcement.
- Inputs: S3 creds, image probe library.
- Outputs: /media/presign; media records linked to products/looks.
- Failure cases: Oversized uploads; missing cleanup on failure; unauth uploads.
- Validation: Integration tests for presign/use; cleanup job tests.

##### Task 2.3: Product & Variant CRUD with Integrity
- Description: Required fields (title, price+currency, category, min images, size options or one-size, inventory, returns eligibility, shipping regions), variants with per-variant stock/status.
- Why: Core catalog correctness.
- Inputs: Pricing rules, inventory model, category taxonomy.
- Outputs: REST/GraphQL endpoints, DB relations, validation layer.
- Failure cases: Zero-image publish; orphan variants; missing returns flags.
- Validation: Contract tests, negative tests for missing required fields.

##### Task 2.4: Collections & Looks
- Description: CRUD for collections (status ACTIVE/INACTIVE, featured, ordering, cover image, optional countdown) and looks (image/video, product hotspots, availability summary).
- Why: Merchandising and social discovery.
- Inputs: CollectionType/visibility enums, product links.
- Outputs: APIs, DB tables, ordering fields, countdown metadata.
- Failure cases: Products removed leaving invalid look; countdown expired without reset.
- Validation: E2E for create/update/delete; integrity checks on product links.

##### Task 2.5: Slug History & Redirects
- Description: Track slug changes and provide 301 redirect mapping service.
- Why: SEO continuity.
- Inputs: Slug history table.
- Outputs: Middleware/edge redirect config; admin audit.
- Failure cases: Redirect loops; stale cache.
- Validation: Tests for change history; redirect resolution tests.

##### Task 2.6: Draft/Publish Gating & Checklist
- Description: Readiness checklist (>=3 hero products, 1 collection/look, policies set, media standards met), block publish otherwise.
- Why: Quality bar and revenue readiness.
- Inputs: Store/product state.
- Outputs: Checklist API, publish guard.
- Failure cases: Race between checklist and publish; incorrect counts.
- Validation: E2E for gating; concurrency tests.

### Plan 3: Checkout, Pricing, Payments, Refunds
**Priority:** P0  
**Why this exists:** Revenue capture; must support regional payment methods and refunds.

**What is included:** Cart service, pricing engine (base, compareAt, discounts, currency handling, rounding), tax/VAT (Nigeria 7.5%), fees, payment orchestration (cards, bank transfer, USSD, mobile money), BNPL scaffolding, auth/capture, partial captures/refunds, settlement records, FX handling rules, gift card scaffolding, first-order incentives, oversell protection via reservations.

**What is explicitly excluded:** BNPL provider integration (stub), full wallet, crypto, multi-merchant split payments (future).

**Dependencies:** Plan 2 (catalog), Plan 6 (inventory/reservations from trust? maybe own), payment provider accounts, tax config.

**Risks & Edge Cases:** ⚠️ FX rounding mismatches; ⚠️ payment webhook spoofing; ⚠️ oversell under high concurrency; ⚠️ partial refund edge logic.

**Success Criteria:** Successful payment flow with auth/capture/refund; oversell prevented; price totals consistent; VAT applied; audit trail for payments; p95 checkout API <400ms excluding provider latency.

#### Tasks Breakdown

##### Task 3.1: Cart & Pricing Engine
- Description: Build cart service with line items, currency, promotions, compareAt, rounding rules, promo locking, display vs settlement currency.
- Why: Accurate totals for checkout.
- Inputs: Product pricing, promotion rules, currency config.
- Outputs: Cart APIs; pricing library; promotion validation.
- Failure cases: Negative totals due to stacking; stale prices.
- Validation: Unit tests for math; property-based tests for promo stacking.

##### Task 3.2: Inventory Reservation
- Description: Short-term stock reservation during checkout; release on timeout or failed payment.
- Why: Oversell protection.
- Inputs: Inventory counts; reservation TTL config.
- Outputs: Reservation table, cron/queue for expiries; API hooks on cart/checkout.
- Failure cases: Leaked holds; double holds per user/device.
- Validation: Concurrency tests; expiry tests.

##### Task 3.3: Payment Orchestrator
- Description: Integrate payment providers (cards, bank transfer, USSD, mobile money) with unified interface; webhooks with HMAC validation; idempotency keys.
- Why: Reliable payments with multiple rails.
- Inputs: Provider credentials; callback URLs; secrets.
- Outputs: /checkout/pay, /payments/webhook; payment intents; status machine.
- Failure cases: Webhook replay; mismatched amounts; currency not supported.
- Validation: Sandbox E2E; webhook signature tests; idempotency tests.

##### Task 3.4: Refunds & Partial Captures
- Description: Support partial capture/refund per item; FX rounding; ledger entries.
- Why: Post-purchase operations.
- Inputs: Payment records; order items; FX rates.
- Outputs: Refund API; ledger updates; audit logs.
- Failure cases: Double refund; FX drift; provider decline handling.
- Validation: Unit tests per scenario; reconciliation reports.

##### Task 3.5: Taxes & Fees
- Description: VAT 7.5% Nigeria; per-region tax rules config; duty flags.
- Why: Compliance and accurate totals.
- Inputs: Region mapping; product taxability.
- Outputs: Tax calculator module; tax breakdown lines.
- Failure cases: Incorrect rounding; wrong tax class.
- Validation: Golden test cases for tax; contract tests.

### Plan 4: Shipping, Addresses, Fulfillment & Returns
**Priority:** P1  
**Why this exists:** Deliver purchased goods; manage exceptions/returns/exchanges.

**What is included:** Address validation (local formats), shipping regions allow/deny per store/product, delivery estimates, partial shipments, exceptions (lost/damaged), return/exchange flow with eligibility and restock, promised-by tracking, size guarantee flag, try-before-buy scaffold.

**What is explicitly excluded:** Carrier integrations automation (manual entry first), offline mode, native wallet boarding passes.

**Dependencies:** Plan 3 (orders/payments), Plan 2 (catalog inventory flags), notification service.

**Risks & Edge Cases:** ⚠️ Incorrect address parsing in Nigeria formats; ⚠️ return abuse; ⚠️ promised-by SLA breaches; ⚠️ inventory mismatch after returns.

**Success Criteria:** Orders have shipping options; returns/exchanges process updates inventory and refunds; SLA timers tracked; user notified on delays.

#### Tasks Breakdown

##### Task 4.1: Address & Region Handling
- Description: Address model with landmarks/notes; validation service; allow/deny lists per store/product.
- Why: Accurate delivery and compliance.
- Inputs: Region config; validation rules.
- Outputs: Address APIs; per-store region settings.
- Failure cases: Rejecting valid local formats; missing phone validation.
- Validation: Fixtures for Nigerian addresses; negative tests.

##### Task 4.2: Shipping Options & Estimates
- Description: Shipping method config per store; delivery estimates; pricing per region/weight.
- Why: Transparency and cost calc.
- Inputs: Store settings; product weight/dimensions.
- Outputs: Shipping quote API; estimate surfaces in checkout.
- Failure cases: Zero options; wrong estimate due to missing weight.
- Validation: Unit tests with varied weights/regions.

##### Task 4.3: Fulfillment States & Partial Shipments
- Description: Order item state machine; allow partial shipments and tracking.
- Why: Real-world logistics.
- Inputs: Orders; shipping events.
- Outputs: Shipment records; item-level statuses.
- Failure cases: Items stuck in limbo; double shipment.
- Validation: State transition tests; E2E for partial shipments.

##### Task 4.4: Returns/Exchanges Flow
- Description: Return eligibility flags per variant; return window; restock on return; exchange flow with inventory checks; disposition tracking.
- Why: Customer support and inventory accuracy.
- Inputs: Order history; variant flags; inventory service.
- Outputs: Return requests; approvals; inventory adjustments; refund triggers.
- Failure cases: Refund without item receipt; fraud; incorrect restock.
- Validation: E2E returns; fraud rule tests; inventory reconciliation.

### Plan 5: Trust, Safety, Moderation & Policy Enforcement
**Priority:** P1  
**Why this exists:** Prevent abuse, ensure policy compliance, manage takedowns and reviews.

**What is included:** Review queues (automated/human), schedulable windows, manual override, policy enforcement states, rejection reasons, audit logs, takedown/restore, rate limits/throttles, abuse controls (shadow-mute, velocity limits), image hashing hooks, profanity/NSFW checks (basic), appeal flow scaffold.

**What is explicitly excluded:** Full AI-generated content detection accuracy, advanced fraud scoring, cross-platform threat intel.

**Dependencies:** Plan 1 (auth), Plan 2 (catalog entities), Plan 9 (notifications for alerts), logging/metrics.

**Risks & Edge Cases:** ⚠️ Over-blocking reducing revenue; ⚠️ under-blocking leading to legal risk; ⚠️ latency from content checks.

**Success Criteria:** Review queue operational; policy states enforced on publish; takedowns propagate to CDN purge; audit trails present; rate limits in place.

#### Tasks Breakdown

##### Task 5.1: Moderation Models & States
- Description: Add moderation tables with states (PENDING_REVIEW, APPROVED, REJECTED, TAKEDOWN), reasons, reviewer identity, schedule windows.
- Why: Structured policy enforcement.
- Inputs: Schema; policy reasons taxonomy.
- Outputs: DB tables; indexes; service methods.
- Failure cases: Missing audit; state stuck; incorrect inheritance to variants/media.
- Validation: State transition tests; audit presence checks.

##### Task 5.2: Review Queues & Workflows
- Description: API/UI for moderators; scheduling; manual override; appeal stub.
- Why: Operability.
- Inputs: Moderation states; roles; notifications.
- Outputs: Queue endpoints; reviewer assignment.
- Failure cases: Lost assignments; race conditions.
- Validation: E2E for assign/decide; concurrency tests.

##### Task 5.3: Abuse Controls & Rate Limits
- Description: Velocity limits on uploads/posts/price changes; shadow-mute; throttles for new sellers.
- Why: Abuse prevention.
- Inputs: Redis rate limits; role data; account age.
- Outputs: Guard middleware; configs per action.
- Failure cases: False positives blocking legitimate use; unbounded burst.
- Validation: Load tests; unit tests for counters.

##### Task 5.4: Content Safety Hooks
- Description: Basic profanity/NSFW checks; image hashing stub; webhook to future classifier.
- Why: Compliance and brand safety.
- Inputs: External APIs; media metadata.
- Outputs: Flags on content; moderation queue triggers.
- Failure cases: High false positives; latency.
- Validation: Sample set tests; fallback path when API fails.

### Plan 6: Private Collections, Visibility & Access Control
**Priority:** P1  
**Why this exists:** Private collections per provided backend requirements; access control, categories, types, invite links, realtime gating, notifications.

**What is included:** Collection visibility (PUBLIC/PRIVATE) orthogonal to status; CollectionAccess with states (PENDING/APPROVED/REVOKED); categories seeded; CollectionType enum; canView enforcement across collection/media/comments/views; access management endpoints; metrics; invite links (HMAC signed, TTL) behind flag; realtime room authorization; notifications to USER rooms.

**What is explicitly excluded:** Brand-level blanket approvals; admin UI dashboards (future); long-term metrics store (logs only initially).

**Dependencies:** Plan 1 (auth), Plan 2 (collections base), Plan 9 (notifications), WebSocket gateway.

**Risks & Edge Cases:** ⚠️ 404 vs 403 consistency; ⚠️ expired invites reuse; ⚠️ view counts leakage; ⚠️ race in approvals.

**Success Criteria:** Unauthorized users receive 404; access requests/approvals/revokes function; invite tokens validate TTL/HMAC; realtime joins gated; metrics endpoints return scoped counts.

#### Tasks Breakdown

##### Task 6.1: Schema & Seeds
- Description: Add enums, CollectionAccess table, CollectionCategory seed (African Fashion, Western Fashion, De House), CollectionType enum.
- Why: Data model support.
- Inputs: Prisma schema; seed scripts.
- Outputs: Migration; seed job.
- Failure cases: Missing indexes on (collectionId,state,userId); duplicate seeds.
- Validation: Migration tests; seed idempotence.

##### Task 6.2: Access Enforcement Layer
- Description: Helpers canViewCollection/canViewMedia; apply across collection reads, media likes, comments v2, recordView.
- Why: Security of private content.
- Inputs: Auth context; access table.
- Outputs: Shared guard functions; integrated service checks.
- Failure cases: Missed call sites; caching stale approvals.
- Validation: Unit tests on guards; E2E for unauthorized 404; regression tests on media/comments.

##### Task 6.3: Access Management Endpoints
- Description: Request access, approve/reject, bulk approve, revoke, list pending/approved.
- Why: Operational flow for private collections.
- Inputs: Access states; owner identity.
- Outputs: Controller routes; service methods.
- Failure cases: Approve already revoked; double approvals; owner revoking self.
- Validation: Contract tests; negative tests.

##### Task 6.4: Invite Links (Feature-flag)
- Description: Generate/validate HMAC-signed tokens with short TTL; accepting grants APPROVED.
- Why: Self-service access.
- Inputs: Signing key env; feature flag.
- Outputs: /collections/:id/invite/create and /accept endpoints; token validation.
- Failure cases: Token replay; clock skew; missing flag gating.
- Validation: Unit tests for HMAC; expiry tests; flag off behavior.

##### Task 6.5: Realtime & Notifications
- Description: Gate WebSocket rooms by canView; USER rooms for notifications; emit on approvals.
- Why: Consistent privacy and UX.
- Inputs: EventsGateway; NotificationsService.
- Outputs: Join auth; events.
- Failure cases: Room leakage; stale membership.
- Validation: WebSocket join tests; notification receipt tests.

### Plan 7: Social Graph & Engagement
**Priority:** P2  
**Why this exists:** Drive discovery and retention: follows, likes, wishlists, boards, activity feeds.

**What is included:** Follow system, likes for products/looks/posts, wishlists, style boards/mood boards with visibility, activity feed with privacy controls, copy board functionality, social proof counters.

**What is explicitly excluded:** Live comments/DM, real-time feed ranking (basic chronological only initially).

**Dependencies:** Plan 1 (auth), Plan 2 (catalog), Plan 6 (canView checks for private items), Plan 9 (notifications).

**Risks & Edge Cases:** ⚠️ Counter skew; ⚠️ privacy leaks via feed; ⚠️ rate abuse on likes/follows.

**Success Criteria:** Users can follow/unfollow; likes/wishlists/boards work with privacy rules; feed shows authorized items only; rate limits in place.

#### Tasks Breakdown

##### Task 7.1: Follow System
- Description: Follow table with privacy controls; endpoints to follow/unfollow; counters.
- Why: Social discovery.
- Inputs: User IDs; privacy flags.
- Outputs: DB tables; APIs; counters.
- Failure cases: Follow self; duplicate follows; privacy bypass.
- Validation: Unit + E2E; counter reconciliation job.

##### Task 7.2: Likes/Wishlists
- Description: Reactions on products/looks/collections; wishlist per user; counters.
- Why: Engagement and intent.
- Inputs: Item IDs; user context.
- Outputs: Reaction tables; APIs; counters.
- Failure cases: Duplicate likes; private content leak; counter drift.
- Validation: Idempotency tests; privacy tests.

##### Task 7.3: Style Boards
- Description: Board CRUD, visibility (PRIVATE/PUBLIC), add products, copy board.
- Why: Curation and sharing.
- Inputs: Products; user.
- Outputs: Board tables; endpoints.
- Failure cases: Copy of private items without rights; deleted product stubs.
- Validation: E2E create/update/copy; privacy tests.

##### Task 7.4: Activity Feed (Chronological)
- Description: Feed of follows/likes/boards respecting privacy and canView.
- Why: Retention.
- Inputs: Social events; access guards.
- Outputs: Feed API; pagination.
- Failure cases: N+1 queries; leaking private actions.
- Validation: Load tests; privacy unit tests.

### Plan 8: Creator & Affiliate Program
**Priority:** P2  
**Why this exists:** Revenue via influencer/creator partnerships and affiliate tracking.

**What is included:** Creator onboarding and verification tiers, creator storefront, affiliate links/codes, attribution window config, clicks/conversions tracking, earnings dashboard, payout schedule alignment, early access for creators to drops.

**What is explicitly excluded:** Automated creator verification scoring, complex commission splits per product/creator (basic base rate + bonus only now).

**Dependencies:** Plan 1 (roles), Plan 2 (catalog), Plan 3 (orders data), Plan 7 (social), analytics pipeline.

**Risks & Edge Cases:** ⚠️ Commission fraud via self-purchase; ⚠️ cookie/UTM loss; ⚠️ incorrect attribution window; ⚠️ payouts miscalc.

**Success Criteria:** Creators can be onboarded and tiered; affiliate links generate tracked events; conversions attributed within window; earnings dashboard matches ledger.

#### Tasks Breakdown

##### Task 8.1: Creator Profile & Verification
- Description: Creator profile schema; verification tiers (Emerging/Rising/Established/Elite); application/approval flow.
- Why: Control quality and permissions.
- Inputs: User data; follower metrics (manual initially).
- Outputs: Tables; endpoints; admin review UI stub.
- Failure cases: Wrong tier assignment; missing appeals.
- Validation: E2E for application/approval; role checks.

##### Task 8.2: Affiliate Link/Code Generation
- Description: Unique links/codes per creator/product/store; UTM parameters; short links.
- Why: Track referrals.
- Inputs: Creator profile; product/store IDs.
- Outputs: Link generation service; code store.
- Failure cases: Collision; code guessing; missing expiry.
- Validation: Uniqueness tests; security tests.

##### Task 8.3: Attribution & Conversion Logging
- Description: Track clicks and conversions with attribution window (7–30 days configurable); store cookie/identifier; attribute orders.
- Why: Pay commissions correctly.
- Inputs: Orders; click logs; cookies.
- Outputs: Attribution table; mapping to orders.
- Failure cases: Multiple attributions; window miscalc; device switches.
- Validation: Unit tests for window logic; reconciliation job.

##### Task 8.4: Earnings & Payouts
- Description: Compute commissions; dashboard; payout schedule; minimum threshold; exportable reports.
- Why: Creator trust and payments.
- Inputs: Attributed orders; rates; payout config.
- Outputs: Earnings ledger; API for dashboard; CSV export.
- Failure cases: Negative earnings; duplicate payouts.
- Validation: Ledger tests; payout simulation.

### Plan 9: Notifications & Communication
**Priority:** P1  
**Why this exists:** Inform users of key events (order status, access approvals, price drops, back-in-stock, review reminders), with channel preferences and routing.

**What is included:** Email/push channels now; SMS behind feature flag; notification templates; routing rules per preference; fallback to email; USER rooms for realtime; rate limits; audit logs.

**What is explicitly excluded:** In-app rich inbox UI (basic list only), SMS production rollout.

**Dependencies:** Plan 1 (users), Plan 3 (orders), Plan 6 (private collections), Plan 7 (social events), messaging infra.

**Risks & Edge Cases:** ⚠️ Notification storms; ⚠️ duplicate sends; ⚠️ PII in logs; ⚠️ push token expiry.

**Success Criteria:** Templates exist; events trigger notifications per preference; SMS disabled unless flag on; delivery metrics logged.

#### Tasks Breakdown

##### Task 9.1: Notification Preferences Model
- Description: Per-user channel prefs per event type; quiet hours stub.
- Why: Compliance and UX.
- Inputs: User IDs; defaults.
- Outputs: Pref table; API.
- Failure cases: Ignoring opts-out; bad defaults.
- Validation: Pref resolution tests.

##### Task 9.2: Template & Sender Service
- Description: Template rendering for email/push; provider adapters; audit metadata.
- Why: Consistency and speed.
- Inputs: Template files; provider creds.
- Outputs: Rendering service; send API.
- Failure cases: Missing variables; provider failure.
- Validation: Snapshot tests; retry tests.

##### Task 9.3: Event Wiring
- Description: Hook domain events (order status, access approved, price drop, back-in-stock, waitlist) to notification service via bus.
- Why: End-to-end delivery.
- Inputs: Event bus; domain services.
- Outputs: Consumers; mapping table.
- Failure cases: Lost events; duplication.
- Validation: Integration tests with fake bus; idempotency tests.

### Plan 10: Analytics, Experimentation, Observability
**Priority:** P1  
**Why this exists:** Measure funnel, detect issues, run experiments; ensure operability.

**What is included:** Event taxonomy (views, add-to-bag, checkout steps, payments, refunds, notifications), exposure logging with holdouts, sample ratio checks, metrics/alerts, tracing, structured logging, dashboards, runbooks, consent tagging for PII, retention windows.

**What is explicitly excluded:** Full data warehouse and ML feature store (later), real-time stream processing at massive scale (batch acceptable initially).

**Dependencies:** Event bus, storage (object store/OLAP), app instrumentation.

**Risks & Edge Cases:** ⚠️ PII leakage; ⚠️ sampling bias; ⚠️ missing tracing in websockets.

**Success Criteria:** Events emitted for all key actions; dashboards for checkout success, drop performance, notification delivery; alerts on error rates and latency; tracing covers 80% of requests.

#### Tasks Breakdown

##### Task 10.1: Event Taxonomy & SDK
- Description: Define schema; build server/client SDKs; enforce required fields.
- Why: Consistency and quality.
- Inputs: Requirements; domain events.
- Outputs: Taxonomy doc; SDK libraries.
- Failure cases: Version drift; schema violations.
- Validation: Schema validation tests; lint checks.

##### Task 10.2: Instrumentation & Pipelines
- Description: Add instrumentation to services; ship to OLAP (e.g., ClickHouse/BigQuery); consent flags.
- Why: Analytics availability.
- Inputs: SDK; infra.
- Outputs: Event collectors; ETL jobs.
- Failure cases: Data loss; PII non-compliance.
- Validation: End-to-end event flow tests; backfill checks.

##### Task 10.3: Observability Stack
- Description: Metrics (Prometheus), logs (structured JSON), tracing (OpenTelemetry), alerts, dashboards, SLOs.
- Why: Operability and reliability.
- Inputs: Services; infra.
- Outputs: Dashboards; alert rules; runbooks.
- Failure cases: Alert fatigue; missing log redaction.
- Validation: Chaos drills; alert fire tests.

### Plan 11: Loyalty, Retention & Gamification
**Priority:** P2  
**Why this exists:** Drive repeat purchases and engagement via points, tiers, rewards, streaks, campaigns.

**What is included:** Loyalty accounts with points, tiers (Bronze/Silver/Gold/Platinum), expiry (12-month rolling), earn/burn rules, rewards catalog, streaks, milestone rewards, birthday rewards, win-back campaigns, leaderboards stub, daily rewards.

**What is explicitly excluded:** Complex partner ecosystem, external loyalty integrations.

**Dependencies:** Plan 3 (orders), Plan 9 (notifications), Plan 7 (engagement events), analytics.

**Risks & Edge Cases:** ⚠️ Points fraud; ⚠️ expiry miscalc; ⚠️ leaderboard abuse; ⚠️ double-earn.

**Success Criteria:** Points accrue on purchases and defined actions; expiry job works; tiers upgrade/downgrade correctly; rewards redemption debits points; notifications sent.

#### Tasks Breakdown

##### Task 11.1: Loyalty Account Model
- Description: Account per user with points, lifetimePoints, tier, tierExpiresAt.
- Why: State store for loyalty.
- Inputs: User IDs; order events.
- Outputs: DB tables; indexes.
- Failure cases: Missing row creation; concurrent updates.
- Validation: Unit tests; concurrency tests.

##### Task 11.2: Earn/Burn Engine
- Description: Rules for earning (purchases, reviews, referrals, shares) and burning (rewards redemption); expiry scheduler.
- Why: Core mechanics.
- Inputs: Event stream; rules config.
- Outputs: Transactions ledger; balance updates.
- Failure cases: Negative balance; double earn; expiry race.
- Validation: Property-based tests; reconciliation.

##### Task 11.3: Tiers & Streaks
- Description: Tier thresholds; streak tracking; rewards on milestones; birthday rewards.
- Why: Engagement levers.
- Inputs: Loyalty transactions; dates.
- Outputs: Tier updates; streak counters.
- Failure cases: Timezone issues; streak reset errors.
- Validation: Date-boundary tests; timezone simulation.

### Plan 12: AI/ML Foundations (Size Rec, Visual Search Scaffold)
**Priority:** P2  
**Why this exists:** Reduce returns and improve discovery; fulfill requirements for size recommendations and visual search.

**What is included:** Data collection for size recs (user measurements, past purchases, returns), offline model training pipeline, online inference service for size suggestions; visual search scaffold (image embedding service, nearest-neighbor index), trend prediction stub; content safety signals ingestion.

**What is explicitly excluded:** Full AR try-on; production-grade visual search UI (only API stub); real-time trend prediction at scale.

**Dependencies:** Data pipelines (Plan 10), catalog media, user measurements, returns data.

**Risks & Edge Cases:** ⚠️ Model bias; ⚠️ PII handling of measurements; ⚠️ cold-start.

**Success Criteria:** Size rec API returns suggestions with confidence; offline training reproducible; embeddings stored; privacy controls applied.

#### Tasks Breakdown

##### Task 12.1: Data Contracts & Collection
- Description: Define data needed for size rec (measurements, purchase/return history, fit reviews); instrument collection with consent flags.
- Why: Input quality.
- Inputs: Event schema; profile forms.
- Outputs: Data schemas; consented datasets.
- Failure cases: Missing consent; low coverage.
- Validation: Data completeness dashboards; consent checks.

##### Task 12.2: Training Pipeline
- Description: Batch pipeline to train size rec model; versioning; evaluation metrics.
- Why: Provide recommendations.
- Inputs: Collected data; labels (returns/fit reviews).
- Outputs: Model artifacts; metrics.
- Failure cases: Overfitting; drift.
- Validation: Offline eval; shadow deploy.

##### Task 12.3: Inference Service
- Description: Deploy inference API; latency budget; cache popular results; A/B flag.
- Why: Online recommendations.
- Inputs: Model artifact; feature store.
- Outputs: API responses with size suggestion and confidence.
- Failure cases: Slow inference; stale model.
- Validation: Load test; canary rollout.

##### Task 12.4: Visual Search Scaffold
- Description: Embedding generation for catalog images; ANN index service; search API stub.
- Why: Foundation for visual search feature.
- Inputs: Product media.
- Outputs: Embeddings store; search endpoint.
- Failure cases: Large index memory; poor relevance.
- Validation: Relevance smoke tests; latency tests.

### Plan 13: Frontend Web Experience (Storefront & Dashboard)
**Priority:** P0  
**Why this exists:** User-facing surface for shopping and brand management; must support onboarding, catalog management, checkout, and private collections access.

**What is included:** Web app with store onboarding flow, catalog CRUD UI, collection/looks creation, checkout UI with payment options, private collection access requests, notifications UI, moderation console (MVP), analytics dashboards basic, responsive design; accessibility; caching via CDN; SSR/CSR mix if needed.

**What is explicitly excluded:** Native mobile app; heavy 3D/AR; offline mode.

**Dependencies:** Backend APIs from Plans 1–6 primarily, payments, notifications.

**Risks & Edge Cases:** ⚠️ Form validation gaps leading to bad data; ⚠️ inconsistent gating; ⚠️ SEO issues without SSR for public pages; ⚠️ rate limit handling on client.

**Success Criteria:** Users can complete onboarding, create products, checkout successfully, request/access private collections, receive notifications; lighthouse performance >85 desktop, >75 mobile; WCAG AA basics.

#### Tasks Breakdown

##### Task 13.1: Design System & Component Library
- Description: Build core components (forms, cards, tables, modals), theming, validation patterns.
- Why: Speed and consistency.
- Inputs: Brand guidelines; accessibility standards.
- Outputs: Component library in React; storybook.
- Failure cases: Inconsistent states; inaccessible components.
- Validation: Storybook a11y checks; unit tests.

##### Task 13.2: Store Onboarding UI
- Description: Multi-step wizard with validation, slug availability checks, media uploads, checklist.
- Why: Enable store creation.
- Inputs: Store APIs; media presign.
- Outputs: Pages/forms; progress persistence.
- Failure cases: Lost progress; slug race conditions.
- Validation: Cypress/Playwright flows; offline error handling.

##### Task 13.3: Catalog & Collections UI
- Description: Product/variant forms, media management, collections/looks builder, countdowns.
- Why: Merchandising tools.
- Inputs: Catalog APIs.
- Outputs: CRUD pages; ordering controls.
- Failure cases: Variant orphaning via UI; missing required fields.
- Validation: Form validation; regression tests.

##### Task 13.4: Private Collections Access UX
- Description: Request access CTA, status display, invite acceptance, access-controlled views.
- Why: Support Plan 6.
- Inputs: Access APIs; invite tokens.
- Outputs: UI states; 404 handling; realtime updates.
- Failure cases: Showing private content before approval; stale status.
- Validation: E2E with unauthorized/authorized users.

##### Task 13.5: Checkout UI & Payments
- Description: Cart page, shipping selection, payment method selection, error handling, success/failure states.
- Why: Revenue capture front door.
- Inputs: Cart/pricing APIs; payment orchestrator.
- Outputs: Checkout flow; receipt page.
- Failure cases: Double submission; stale totals; payment decline handling.
- Validation: E2E per payment rail; promo edge cases.

##### Task 13.6: Moderation & Support Consoles (MVP)
- Description: Basic moderator queue view; support impersonation UI; audit trails.
- Why: Operability.
- Inputs: Moderation APIs; impersonation endpoints.
- Outputs: Console pages.
- Failure cases: Support making writes; missing audit display.
- Validation: Role-based E2E.

## 4. Cross-Cutting Concerns
- Security: HMAC for webhooks/invites; JWT with rotation; OWASP controls; CSRF for web; secret management; audit logs; PII minimization; GDPR/CCPA alignment; access tokens scoped; object storage signed URLs; rate limits.
- Performance: Caching on reads (Redis/CDN); pagination; indexes; async jobs for heavy tasks; image optimization; SSR for SEO-critical pages.
- Observability: Structured logging with correlation IDs; metrics per service; tracing via OpenTelemetry; SLOs and alerts; dead-letter queues monitored.
- Compliance: KYC/AML for payouts; PCI-DSS scope reduction (tokenize cards via provider); VAT compliance; data retention policies; consent tracking for analytics/ML.
- Feature flags & rollout: Use flags for risky features (invite links, SMS, BNPL, visual search); gradual rollout with canary; kill switches for payments and notifications.

## 5. Execution Notes
- Suggested sequencing: Plans 1, 2, 13 in parallel start; then 3 and 6; then 9 and 10; then 4 and 5; P2 plans (7,8,11,12) after core revenue and trust. Always land observability early (Plan 10 tasks 10.1/10.3 alongside first services).
- Parallelization: Backend auth + catalog + frontend onboarding can run together. Payments and inventory reservation need catalog readiness. Notifications wiring can run in parallel once events defined. AI/ML can start data contracts early while models later.
- What should NEVER be built first: Gamification/leaderboards before checkout reliability; advanced AI/visual search before baseline catalog/checkout; SMS/BNPL before core payments stable; complex moderation automation before manual workflows.
- Common mistakes: Missing 404 vs 403 semantics on private collections; not enforcing variant/media integrity leading to orphan data; lacking idempotency on payments/webhooks; counter drift without reconciliation; inadequate rate limits on uploads and likes; forgetting consent for analytics/ML; failing to purge CDN on takedown.
