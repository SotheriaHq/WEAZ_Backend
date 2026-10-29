# Design taxonomy proposals

## Product rules

A brand may propose a category and garment type together while creating or editing a design. Content review and taxonomy review are independent. Approving content can publish a submitted design while its proposed taxonomy remains pending. Approving taxonomy never publishes a draft. A rejected proposal does not unpublish an already approved design or disable an existing category.

Pending categories and garment types are absent from public taxonomy and category-filtered searches. A design using a pending pair has neither public category key assigned. Taxonomy approval creates or resolves the category and garment type together, then assigns both keys to linked designs without changing their publication status. A brand's later explicit category choice wins over an earlier proposal.

Existing categories may receive proposed new garment types. Category-only requests remain available in settings, but cannot satisfy a design's category-and-garment-type requirement. All other publishing requirements remain: required media, title, audience, tags, style and custom-order readiness.

## Permissions and interaction

Only the proposing brand's owner or active member may attach its private proposal to a new design. Rejected proposals cannot be attached. Existing links survive membership changes. Reviewers approve taxonomy separately in the administrative taxonomy queue; content reviewers do not grant taxonomy approval.

Web creation and native creation/editing use the canonical design API. Forms offer the same proposal pair and retain entered values after a failed request. Lists load only when needed, use cursor pages of 25 and support retry and further pages. The server serializes the five-request-per-user daily quota and coalesces concurrent requests for the same pair. Names accept ordinary punctuation and international letters while refusing control and directional formatting characters. Existing category URLs remain stable.

## Consistency and operations

The source design is locked and its draft version checked before mutation. A publish request that waited behind taxonomy approval receives a version conflict instead of overwriting the approved keys. Review submission, inbox notice and channel intent commit together. A notification failure rolls back submission so a retry cannot create a false or duplicate notice. External delivery occurs after commit.

Migration `20261028110000_category_garment_proposals` adds the proposed type and an approved category/type relationship enforced by a composite foreign key. It does not auto-approve existing requests or publish old drafts.

## Verification and limits

Local evidence on 28 October: 14 actual PostgreSQL scenarios pass, including opposing reviewers, quota contention, private attachment, notification rollback, independent approvals, rejection, international names and a real publish lock waiter. Four focused backend suites pass 58 tests; three web suites pass 11 tests; web and native type checks and native proposal/editor contracts pass. Native design audit reports zero findings against the actual isolated checkout.

These are local implementation checks. SIT migration, remote CI, interactive desktop/tablet/mobile-browser checks and Android/iOS acceptance remain release gates. No live provider delivery or device behavior is certified by these tests.
