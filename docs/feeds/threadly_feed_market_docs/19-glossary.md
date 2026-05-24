# Glossary

| Term | Meaning |
|---|---|
| FeedCategory | A browsing/ranking source for design feed |
| MarketSection | A configured area of Market home |
| RankingProfile | Versioned scoring weight configuration |
| SuggestionBlock | A suggestion area on a market-related screen |
| Context-Aware Suggestion | Suggestion based on screen/user/current item |
| View All | Section expansion screen/page |
| Signal | User/system interaction event |
| Seen item | Item served or viewed by user/session |
| Suppression | Hidden/muted/reduced content |
| Fairness boost | Controlled new/underexposed brand exposure |
| Freshness | How recently item was created/restocked |
| Velocity | Recent rate of interaction per impression/time |
| Commerce readiness | Whether item can convert: price, stock, orderable, store open |
| Brand quality | Reliability, completeness, fulfillment, policy score |
| Cold start | New user/item/brand with insufficient history |
| Soft reset | Ignore old personalization signals after reset date without deleting analytics |
| Section-first | Market page built from purposeful sections |
| Category-supported | Categories exist but do not dominate the market home |
| Patch | Threadly's relationship action. A user patches a brand, and brands can request/accept brand patches. This replaces follow/following terminology in new product work. |
| PatchConnection | Backend model for accepted user-to-brand and brand-to-brand patch relationships. |
| BrandPatch | Backend model for brand-to-brand patch request workflow. |
| Follow / Follower | Legacy terminology only. Existing code may expose `Follow`, `FOLLOW`, or `followersCount` compatibility fields, but new docs/UI/API work should use patch terminology unless documenting legacy drift. |
| Non-personalized fallback | A feed or market ranking option that does not use user profiling signals; usually chronological, editorial, or broad trending. |
| Personalized response cache safety | Requirement that user-specific feed/market payloads are not stored in shared caches and are scoped by viewer context or marked private/no-store. |
| Anonymous session ID | Client-generated guest identifier used for guest signals and suppressions. It is not a user ID and must not be trusted as authentication. |
| UserFeedSignal | Append-style event row for item, section, and suggestion interactions that can later feed ranking aggregates. |
| UserSeenItem | Lightweight seen/impression record used for future dedupe and analytics. Phase 2 records it but does not rank from it yet. |
| MarketSectionSignal | Event row for market section visibility, scroll, and detail actions. |
| SuggestionSignal | Event row for future context-aware suggestion blocks and suggestion item interactions. |
| UserContentSuppression | User/session control record for hidden or reduced content such as an item, brand, category, section, or suggestion block. |
| PersonalizationReset | Soft reset marker. Future ranking should ignore older personalization signals after `resetAt` without deleting analytics rows by default. |
| Batch signal ingestion | Client sends a bounded array of events to one endpoint instead of making one network request per impression or click. |
