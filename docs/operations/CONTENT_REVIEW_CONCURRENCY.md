# Content review consistency

Submission creation/resubmission and admin decisions lock the same Product or
Collection row before changing submission records. A decision then locks and
rereads its submission. Only the current `IN_REVIEW` submission and a current,
undeleted, unarchived source awaiting review can be decided. Conflicting or
stale requests return HTTP 409 with a queue-refresh instruction. Self-review
remains forbidden.

Saving a draft/withdrawing cannot be undone by an older admin approval. A
resubmission supersedes prior open submissions while retaining terminal history.
The stored review fingerprint must match the current source. Approval also
rechecks required media slots, completed processing, file availability and media
review eligibility through the existing shared publishing validators.

The decision, media status, audit, brand-trust event, notification inbox and
channel instruction commit together. A channel-instruction failure rolls them
all back; the admin can retry. Providers are contacted later by the existing
channel dispatcher, outside the review transaction. A stable submission/owner
notification UUID protects the handoff; notification consent still applies.
Optional content IDs are omitted when absent so payload validation does not
silently discard a review outcome. Brand greetings use brand identity.

Content and category moderation remain independent. A design can pass content
review while its proposed category stays pending and absent from public
category search. Approving a category does not publish any draft.

Media deletion, product reordering/clear-all and primary selection now serialize
on that same source row. They recheck the current image list and published-slot
protection after acquiring the lock. A reorder must include all current images;
an older client list cannot erase a concurrent upload. The draft clear-all
operation remains available, and published clear-all remains forbidden.

Both collection media-deletion entry points share one implementation. Detachment,
cover reassignment, last-media soft deletion and unused-file/storage-deletion
queueing share one transaction. No storage request happens before commit. Files
still referenced by another source are retained. A queue failure rolls back the
whole mutation, so retry cannot leave a broken cover or a database row pointing
at an already-deleted object.

Permanent design removal follows the same durable storage handoff. It rechecks
the source after locking, detaches media in batches of at most 500 and queues
unused originals plus variants in the database. Shared files remain intact.
Both design and store-collection permanent removal refuse a restore that won
the source lock first. Competing permanent removals cannot repeat storage work.

Both design route families use the shared Collection service and integrity
service. Product review uses the same integrity service. Desktop/tablet/mobile
browser and native clients inherit the backend guards and notification payload.
The admin review screen is web-only and already limits decision controls to
`IN_REVIEW` submissions. This change does not certify visual or device delivery
behaviour.

Reproduce database races with `scripts/verify-checkout-media-batching.cjs`, which
creates and removes a disposable loopback PostgreSQL database. Its content-review
module covers competing decisions, withdrawal/resubmission lock waits, changed
fingerprints, media readiness, self-review, deletion, transactional notification
failure, concurrent submissions and media changes. The focused option
`--content-review-only` writes its own 20-scenario proof without overwriting the
combined suite's evidence. Use the proof's `checkedAt` and `passed`
fields to distinguish a successful run from retained failure diagnostics.
