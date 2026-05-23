# Legal, Terms & Conditions, Privacy, and User Reference Docs

## Phase 0 alignment note - 2026-05-23

- Current implementation does not have a documented feed/market personalization disclosure in the inspected docs.
- User-facing copy must explain that Threadly may use views, saves, patches, threads, bagging/order activity, search terms, location preference, and device/session context to rank market/feed content if those signals are implemented.
- A non-personalized fallback should be available and described in plain language.
- Location use must remain opt-in and limited to the stated purpose.
- Analytics and recommendation signals should be covered by Privacy Policy language before signal ingestion ships.
- Personalized API responses should not be stored in shared caches; use safe `Cache-Control` policy and client cache scoping.

Research basis: FTC privacy guidance emphasizes clear disclosure for personal data use, MDN documents `private`/`no-store` cache safety for personalized responses, and EU DSA-style recommender transparency is a useful product benchmark even before Threadly reaches large-platform thresholds.

## Disclaimer

This is product/legal documentation guidance, not legal advice. Final Terms, Privacy Policy, and consumer protection wording should be reviewed by qualified legal counsel.

## Terms & Conditions additions

Add clauses covering:

1. Personalized recommendations.
2. Feed and market ranking.
3. User interactions affecting recommendations.
4. Hidden/muted content.
5. Brand/product visibility not guaranteed.
6. New-brand exposure/fairness does not guarantee sales.
7. Admin/editorial featured placement.
8. Product availability, stock, and custom order availability.
9. Marketplace search and suggestions.
10. User-generated content and comments.
11. Prohibited manipulation of views, saves, orders, comments.
12. Fraudulent or counterfeit listings.
13. Product removal, suppression, archive, or demotion.
14. Device/session security controls.
15. Location-based features.
16. Notifications and opt-out.
17. Analytics and service improvement.
18. Deep links and third-party sharing.
19. Marketplace responsibility and brand obligations.

## Privacy Policy additions

Add clauses covering:

1. Recommendation data collected: views, dwell, clicks, saves, wishlist, cart, purchases, comments, shares, hides, muted brands.
2. Location data: exact only with consent, approximate/IP fallback, ability to disable.
3. Device/session data: login security, IP/user-agent/device metadata.
4. Analytics: section impressions, suggestion impressions, interaction events.
5. Data retention: raw signals, aggregates, security logs.
6. User controls: reset personalization, manage hidden content, notification preferences.
7. Brand/admin data: product/brand performance metrics.
8. No sale of personal data to advertisers, if that is the policy.
9. Legal basis/consent depending on user region.

## User help/reference docs

| User doc | Purpose |
|---|---|
| How recommendations work | Explain personalization simply |
| How to reset your feed | User control |
| How to hide products/brands | User control |
| Why am I seeing this? | Transparency |
| Managing location preferences | Privacy |
| Managing notifications | Control |
| Managing devices | Security |
| How market sections work | Education |
| How suggestions work | Trust |

## Brand help docs

| Brand doc | Purpose |
|---|---|
| How products appear in Market | explain ranking factors |
| How new brands get discovered | fairness explanation |
| Improving product visibility | quality guidance |
| Why a product may be hidden/suppressed | policy/quality |
| Product image and media standards | quality |
| Stock/custom-order requirements | commerce readiness |
| Avoiding duplicate/counterfeit content | trust |

## Admin reference docs

| Admin doc | Purpose |
|---|---|
| Managing feed categories | governance |
| Managing market sections | governance |
| Managing suggestion blocks | governance |
| Ranking profile guide | safe formula edits |
| Formula version rollback | operations |
| Audit log guide | compliance |
