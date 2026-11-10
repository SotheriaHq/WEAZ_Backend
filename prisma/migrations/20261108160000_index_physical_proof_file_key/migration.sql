-- File retention checks use the exact stored-object key, including during
-- concurrent evidence attachment and owned-file deletion.
CREATE INDEX "PhysicalVerificationProof_fileKey_idx"
ON "PhysicalVerificationProof" ("fileKey");
