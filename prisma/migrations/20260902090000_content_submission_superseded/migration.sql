-- A resubmission after "changes requested" left the OLD submission row sitting
-- at CHANGES_REQUESTED forever: createSubmission only cancelled rows that were
-- IN_REVIEW. The admin queue therefore showed a stale change request beside the
-- new pending one, and the summary's changesRequested count never came down.
--
-- SUPERSEDED marks a row that a newer submission replaced. CANCELLED keeps its
-- existing meaning: the brand withdrew the item from review.
ALTER TYPE "ContentSubmissionStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
