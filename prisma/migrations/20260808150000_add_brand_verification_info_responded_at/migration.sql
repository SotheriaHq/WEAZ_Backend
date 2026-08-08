-- When a brand answered an admin's request for more information, the queue row
-- simply returned to IN_REVIEW — visually identical to every other in-review
-- brand. The reviewer who asked had no way to spot, from the table, which brand
-- had actually responded to them.
--
-- `verificationAttemptNumber >= 2` cannot stand in for this: a fresh
-- application filed after a rejection increments the same counter, so the two
-- cases are indistinguishable. This column says exactly one thing — the brand
-- has replied and nobody has acted on the reply yet.
--
-- Set on resubmission, cleared when a new information request goes out or when
-- the reviewer reaches a decision.
ALTER TABLE "Brand"
  ADD COLUMN "verificationInfoRespondedAt" TIMESTAMP(3);
