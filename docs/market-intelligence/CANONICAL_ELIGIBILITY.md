# Canonical public discovery eligibility

The public discovery policy lives in `src/market/eligibility/market-eligibility.ts`.
Its Prisma builder, parameterized SQL fragment and hydrated predicate cover the
same existing product fields. No database migration or new feature flag is
required for this package.

## Policy

A discoverable product must be active, explicitly PUBLISHED, not deleted or
archived, and not scheduled for a future time. Its store must be open and its
owner ACTIVE. Its list price must be positive. It must have stock remaining
after checkout reservations, or support custom orders. Backorders and untracked
zero-stock inventory do not independently qualify a product.

Store collection membership follows one rule: no memberships, or at least one
published, available, nondeleted store collection. Content approval does not
approve a proposed category or garment type; taxonomy approval remains separate.

The database media rule is reference existence: a nonnull thumbnail or a nonempty
image array. Rendering additionally requires a usable, nonblank image reference.
The shared `usableProductImage` selector handles blank thumbnails and arrays
whose first entry is blank. It does not replace upload-content validation.

An active sale already requires a positive sale price below the list price.
Positive list-price eligibility therefore does not depend on the later
`effectivePrice` column. Sale-aware ordering is a separate implementation
package; this change does not claim to implement it.

## Consumers and privacy

The policy covers Market section and contextual suggestion retrieval and nested
covers, public Store product lists and details, slug resolution, SQL search,
search suggestion indexing and cache hydration, public Store Collection paths and commerce products linked from design details/profile lists,
public featured content, and the shared product-access check used by comments
and realtime. All seven suggestion contexts use the same product gate.

Required authority fields must be selected before calling the hydrated gate;
missing status, owner authority or collection memberships fail closed. Additional
caller filters are ANDed with the policy and cannot replace its price constraint.
Public serialization removes the internal owner-status relation and private
collection membership metadata. Owner draft previews retain their authorized
content and collection access.

Collection visibility and product eligibility are separate decisions. A published,
available private collection can satisfy the product membership rule, but its ID,
title and description never appear in public product projections. Public membership
metadata requires explicit PUBLIC visibility; omitted visibility fails closed.

Search caches are accelerators rather than authorization records. Commerce
identities are revalidated in bounded bulk queries. A changed eligible set causes
result counts and pagination to be rebuilt. Product display fields are refreshed
from the authorized row, rather than retaining an obsolete cached cover.

Featured public summaries read authorized fields inside a repeatable-read
transaction, including nested design media. There is no ID-only eligibility
check followed by an unfiltered reread of newly edited content. Administrative
summary and audit behavior remains separate, retaining deleted targets where
appropriate. Scheduled or expired public pins return no public detail.

Wishlist reads retain saved records. A product whose current contents are no
longer public is represented by an unavailable placeholder; its new private
name, images and brand data are not disclosed and buying is disabled. No saved
row is deleted as a side effect of reading the list.

## SQL and query boundaries

SQL identifiers come from a closed registry of literal fragments. Identifiers
are never passed as tagged-template data parameters or constructed from request
input. Dates and other data values remain bound parameters. See the [Prisma raw-query identifier restrictions](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries). Search rows and
counts reuse one captured eligibility fragment per operation.

Prisma relation predicates enforce owner and collection checks without an
application query for each product. Public featured and cached-search hydration
use bulk queries. Commercial mutations, checkout authorization, moderation
writers, owner Studio queries and administrative audit reads have distinct
purposes; they are not replaced by a public discovery query.

## Verification and release

- `npm run test:market-eligibility` runs policy, public-path leak, cache,
  projection and drift regressions. The drift guard includes a deliberate
  copied-predicate negative control.
- `npm run test:market-eligibility-postgres` creates a uniquely named disposable
  loopback-only database, executes the generated Prisma and SQL queries over
  240 deterministic fixtures, compares them with the hydrated predicate and
  fixture truth, checks unpublication and rejects hostile SQL aliases. It drops
  only that test database in cleanup. It refuses remote database hosts.
- Both checks are explicit PR-quality and deployment-precheck steps. Related
  Market, Search, Store, Collection, comment/realtime and curation regressions
  remain required.

This package does not introduce personalization, regional activation, new
retention periods, ranking formulas or schema changes. Client response shapes
are preserved, including the saved-item unavailable state. Web desktop, tablet,
mobile browsers and native reach these shared backend gates; no client-side
ordering or layout changes are included here. Physical-device acceptance is
separate from backend verification.

Rollback is a source revert and redeployment, with no data rollback or reset.
Keep the earlier published-only suggestion containment where possible: reverting
that protection would reopen its disclosure defect. Recheck readiness and
public discovery behavior after either release or rollback.
