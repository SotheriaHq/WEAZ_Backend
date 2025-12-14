# Store TODOs

## Expand Plan Tasks into sprint-ready Jira tickets
- Derive tickets from `docs/implementation-plan.md` Plans 1–13 with focus on Store/Catalog (Plan 2), Checkout/Payments (Plan 3), Private Collections (Plan 6), and Frontend Storefront/Dashboard (Plan 13).
- For each ticket, include: goal, scope, inputs (APIs/configs), outputs (endpoints/DB/UI), acceptance criteria, dependencies, risk notes, estimate, owner, links to PRD/plan section.
- Enforce sequencing: auth (Plan 1) precedes store onboarding; catalog before checkout; checkout before returns; access-control enforcement before private collection UI; notifications wired after events emitted.
- Split large tasks (e.g., Product & Variant CRUD) into backend (schema/migrations/validators), service endpoints, and frontend forms/validation; add testing tasks (unit/integration/e2e) explicitly.
- Add infra tickets for buckets/CDN, secrets, feature flags, monitoring dashboards per domain.
- Create reconciliation tickets for counters (likes/follows) and payments/ledgers as separate recurring ops items.

- Advanced admin dashboards for brand-level blanket approvals on private collections; long-term metrics store beyond initial logs/OLAP; heavy 3D/AR media.

## Identify what we are NOT building in MVP but stakeholders may ask for
- AR virtual try-on; full production visual search UI (only scaffold/indexing); advanced AI content detection and automated moderation; trend prediction at scale.
- Full BNPL provider integration and wallet; crypto; complex multi-merchant split payments; automated carrier integrations; offline mode/mobile-first widgets; Apple/Google Wallet passes.
- Complex partner loyalty integrations; external ERP/POS sync; global SKU registry; org-level SSO/social login; hardware key WebAuthn.
- Live chat/DM and rich community forums; real-time feed ranking; sophisticated gamification (leaderboards, challenges) beyond basic streaks/rewards.
- Full mobile apps; in-app rich inbox; SMS production rollout (behind flag only); automated creator verification scoring; complex commission splits per-product-per-creator.
