# File deletion and orphan cleanup

`DELETE /uploads/:fileId` retains its authenticated owner-only contract and success
body: `{ "message": "File deleted successfully" }`. A missing or other-owner file
returns 400. A file still used by supported content returns 400 before any storage
deletion is queued. An actively processing file returns 409 so the owner can retry.
Malformed UUIDs return 400 at the route boundary.

Successful deletion removes metadata immediately and commits the original and all
stored variant keys to `StorageObjectDeletion` in the same database transaction.
Actual storage removal is asynchronous through the existing five-minute cleanup
worker and its retry policy. An API success is not a receipt for physical deletion
or cache invalidation. A database rollback or outbox insertion error preserves the
file and its variants; no storage request runs inside this transaction.

The current file row is locked before a fresh reference check. Guards cover
message attachments, design/collection media, product media, profile photographs,
profile banners, post images and post video. Nullable and implicit relationships
are checked as well as restrictive foreign keys. Foreign-key locking prevents a
new attachment from committing against a file whose deletion wins the race.
References stored only as URLs are outside this relational guarantee.

Product-media removal first unlinks that product. Its internal cleanup retains a
file still used by another item and returns success for the unlink operation.
Published required-view protection remains in place. Explicit file deletion does
not silently unlink other content.

The message cleanup cron retains the 48-hour cutoff. It delegates one bounded
command (maximum 100 files) with `FOR UPDATE SKIP LOCKED`, rechecks eligibility and
references, and inserts original/version keys through one SQL union/JOIN. Version
keys stay inside PostgreSQL rather than being materialized in application memory.
Busy, referenced, recently uploaded and non-message files are retained. Empty
batches perform no writes, and a zero requested batch size performs no work.

Migration `20261024190500_safe_file_deletion_indexes` supports the age/type scan
and the profile, banner, video and collection-media reference lookups. Apply it
with the standard migration release before enabling the new cleanup producer.
The storage deletion worker must be running; pending jobs are the source of truth
when storage is unavailable. These changes serve the shared HTTP/backend flows
used by desktop, tablet, mobile web and native; no client UI change is required.

Local verification covers owner isolation, references, shared product media,
processing guards, batch limits and failures. The disposable PostgreSQL fixture
also checks real foreign-key lock races, transactional rollback, complete variant
queueing and supporting indexes. Metadata checks make no storage requests. Live
R2/S3 deletion, cache invalidation, storage-worker crash recovery and device UX
remain separate integration/release checks.
