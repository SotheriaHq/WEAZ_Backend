-- Change detection for the review queue.
--
-- Nothing verified that a brand answering a change request actually changed
-- anything: republishing an untouched item put it back in the queue as new
-- work, and the reviewer had no way to tell. Each submission now records what
-- the reviewer could see at the time, so consecutive submissions for one item
-- can be compared.
--
-- All three are nullable. Rows submitted before this migration have no
-- snapshot, and the gate deliberately allows a resubmission it cannot compare
-- rather than blocking a brand over missing history.
ALTER TABLE "ContentSubmission" ADD COLUMN IF NOT EXISTS "contentFingerprint" VARCHAR(64);
ALTER TABLE "ContentSubmission" ADD COLUMN IF NOT EXISTS "contentSnapshot" JSONB;
ALTER TABLE "ContentSubmission" ADD COLUMN IF NOT EXISTS "changeSummary" JSONB;
