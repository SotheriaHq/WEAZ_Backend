-- Support bounded orphan scans and the current-reference guards before file deletion.
CREATE INDEX "FileUpload_type_createdAt_id_idx" ON "FileUpload" ("fileType", "createdAt", "_id");
CREATE INDEX "UserProfile_profileImageId_idx" ON "UserProfile" ("profileImageId");
CREATE INDEX "UserProfile_bannerImageId_idx" ON "UserProfile" ("bannerImageId");
CREATE INDEX "Post_videoId_idx" ON "Post" ("videoId");
CREATE INDEX "CollectionMedia_fileUploadId_idx" ON "CollectionMedia" ("fileUploadId");
