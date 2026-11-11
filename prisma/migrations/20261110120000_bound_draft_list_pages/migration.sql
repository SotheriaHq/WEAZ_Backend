CREATE INDEX "Collection_ownerId_status_createdAt__id_idx"
  ON "Collection" ("ownerId", status, "createdAt", "_id");
CREATE INDEX "Collection_ownerId_domain_status_createdAt__id_idx"
  ON "Collection" ("ownerId", domain, status, "createdAt", "_id");
