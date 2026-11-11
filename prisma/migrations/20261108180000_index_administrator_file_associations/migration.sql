CREATE INDEX "BrandVerificationAttempt_ownerPhotoKey_idx" ON "BrandVerificationAttempt" ("ownerPhotoKey");
CREATE INDEX "BrandVerificationAttempt_idDocumentFrontKey_idx" ON "BrandVerificationAttempt" ("idDocumentFrontKey");
CREATE INDEX "BrandVerificationAttempt_idDocumentBackKey_idx" ON "BrandVerificationAttempt" ("idDocumentBackKey");
CREATE INDEX "BrandVerificationAttempt_cacCertificateKey_idx" ON "BrandVerificationAttempt" ("cacCertificateKey");
CREATE INDEX "BrandVerificationAttempt_authorityProofKey_idx" ON "BrandVerificationAttempt" ("authorityProofKey");
CREATE INDEX "BrandVerificationAttempt_letterOfConfirmationKey_idx" ON "BrandVerificationAttempt" ("letterOfConfirmationKey");
CREATE INDEX "ProductReview_mediaIds_idx" ON "ProductReview" USING GIN ("mediaIds");
