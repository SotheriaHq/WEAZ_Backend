-- The signed-letter flow computed `signedAt` and received `signatureMethod`,
-- but persisted neither. `submit` therefore left BrandVerificationAttempt's
-- letterSignedAt / signatureMethod null, and the admin review page rendered
-- "Signature method: Not recorded" and "Signed at: Not recorded" for every
-- brand — reviewers had no evidence the letter was actually signed.
--
-- Stage them on Brand at signing time so submit can copy them onto the attempt,
-- mirroring how verificationLetterHash / verificationLetterVersion already work.
ALTER TABLE "Brand"
  ADD COLUMN "verificationLetterSignedAt" TIMESTAMP(3),
  ADD COLUMN "verificationLetterSignatureMethod" "VerificationSignatureMethod";
