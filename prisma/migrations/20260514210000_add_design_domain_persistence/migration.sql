ALTER TYPE "SavedItemType" ADD VALUE 'DESIGN';
ALTER TYPE "SavedItemType" ADD VALUE 'PRODUCT';
ALTER TYPE "CommentTarget" ADD VALUE 'DESIGN';
ALTER TYPE "CommentTarget" ADD VALUE 'PRODUCT';
ALTER TYPE "ContentTarget" ADD VALUE 'DESIGN';
ALTER TYPE "ContentTarget" ADD VALUE 'PRODUCT';
ALTER TYPE "FilterEntityType" ADD VALUE 'DESIGN';

CREATE TABLE "Design" (
  "_id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "brandId" UUID,
  "legacyCollectionId" UUID,
  "title" TEXT,
  "description" TEXT,
  "search_vector" tsvector,
  "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT',
  "archivedFromStatus" "CollectionStatus",
  "visibility" "CollectionVisibility" NOT NULL DEFAULT 'PUBLIC',
  "type" "CollectionType" NOT NULL DEFAULT 'EVERYBODY',
  "categoryId" UUID,
  "categoryTypeId" UUID,
  "coverMediaId" UUID,
  "deletedAt" TIMESTAMP(3),
  "deleteExpiresAt" TIMESTAMP(3),
  "lastActivityAt" TIMESTAMP(3),
  "draftVersion" INTEGER NOT NULL DEFAULT 0,
  "minPrice" DOUBLE PRECISION,
  "maxPrice" DOUBLE PRECISION,
  "customOrderEnabled" BOOLEAN NOT NULL DEFAULT false,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "saleMinPrice" DOUBLE PRECISION,
  "saleMaxPrice" DOUBLE PRECISION,
  "saleStartAt" TIMESTAMP(3),
  "saleEndAt" TIMESTAMP(3),
  "sizingMode" "SizingMode" NOT NULL DEFAULT 'NONE',
  "rtwSizes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rtwSizeSystem" TEXT,
  "rtwSizeType" "RtwSizeType",
  "customGender" "Gender",
  "customMeasurementKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "customFreeformPointIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fitPreference" "FitPreference",
  "targetAgeGroup" "AgeGroup" NOT NULL DEFAULT 'ADULT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "metadataEditedAt" TIMESTAMP(3),
  "threadsCount" INTEGER NOT NULL DEFAULT 0,
  "dislikesCount" INTEGER NOT NULL DEFAULT 0,
  "commentsCount" INTEGER NOT NULL DEFAULT 0,
  "collectionCollabsCount" INTEGER NOT NULL DEFAULT 0,
  "viewsCount" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "Design_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "DesignMedia" (
  "_id" UUID NOT NULL,
  "designId" UUID NOT NULL,
  "fileUploadId" UUID NOT NULL,
  "orderIndex" INTEGER NOT NULL DEFAULT 0,
  "mediaType" "FileType" NOT NULL,
  "threadsCount" INTEGER NOT NULL DEFAULT 0,
  "commentsCount" INTEGER NOT NULL DEFAULT 0,
  "legacyCollectionMediaId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DesignMedia_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "DesignDraftSession" (
  "_id" UUID NOT NULL,
  "designId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "sessionToken" TEXT NOT NULL,
  "deviceName" TEXT,
  "deviceType" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "legacyCollectionDraftSessionId" UUID,

  CONSTRAINT "DesignDraftSession_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "Design_legacyCollectionId_key" ON "Design"("legacyCollectionId");
CREATE INDEX "Design_ownerId_status_createdAt_idx" ON "Design"("ownerId", "status", "createdAt");
CREATE INDEX "Design_brandId_status_createdAt_idx" ON "Design"("brandId", "status", "createdAt");
CREATE INDEX "Design_legacyCollectionId_idx" ON "Design"("legacyCollectionId");
CREATE INDEX "Design_status_visibility_createdAt_idx" ON "Design"("status", "visibility", "createdAt");
CREATE INDEX "Design_categoryId_idx" ON "Design"("categoryId");
CREATE INDEX "Design_categoryTypeId_idx" ON "Design"("categoryTypeId");
CREATE INDEX "Design_deletedAt_idx" ON "Design"("deletedAt");
CREATE INDEX "Design_deleteExpiresAt_idx" ON "Design"("deleteExpiresAt");
CREATE INDEX "Design_lastActivityAt_idx" ON "Design"("lastActivityAt");

CREATE UNIQUE INDEX "DesignMedia_legacyCollectionMediaId_key" ON "DesignMedia"("legacyCollectionMediaId");
CREATE INDEX "DesignMedia_designId_orderIndex_idx" ON "DesignMedia"("designId", "orderIndex");
CREATE INDEX "DesignMedia_legacyCollectionMediaId_idx" ON "DesignMedia"("legacyCollectionMediaId");

CREATE UNIQUE INDEX "DesignDraftSession_sessionToken_key" ON "DesignDraftSession"("sessionToken");
CREATE UNIQUE INDEX "DesignDraftSession_legacyCollectionDraftSessionId_key" ON "DesignDraftSession"("legacyCollectionDraftSessionId");
CREATE INDEX "DesignDraftSession_designId_isActive_idx" ON "DesignDraftSession"("designId", "isActive");
CREATE INDEX "DesignDraftSession_ownerId_idx" ON "DesignDraftSession"("ownerId");
CREATE INDEX "DesignDraftSession_expiresAt_idx" ON "DesignDraftSession"("expiresAt");
CREATE INDEX "DesignDraftSession_legacyCollectionDraftSessionId_idx" ON "DesignDraftSession"("legacyCollectionDraftSessionId");

ALTER TABLE "EntityFilter" ADD COLUMN "designId" UUID;
CREATE INDEX "EntityFilter_designId_idx" ON "EntityFilter"("designId");

ALTER TABLE "Design"
ADD CONSTRAINT "Design_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Design"
ADD CONSTRAINT "Design_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Design"
ADD CONSTRAINT "Design_legacyCollectionId_fkey"
FOREIGN KEY ("legacyCollectionId") REFERENCES "Collection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Design"
ADD CONSTRAINT "Design_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Design"
ADD CONSTRAINT "Design_categoryTypeId_fkey"
FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Design"
ADD CONSTRAINT "Design_coverMediaId_fkey"
FOREIGN KEY ("coverMediaId") REFERENCES "DesignMedia"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DesignMedia"
ADD CONSTRAINT "DesignMedia_designId_fkey"
FOREIGN KEY ("designId") REFERENCES "Design"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesignMedia"
ADD CONSTRAINT "DesignMedia_fileUploadId_fkey"
FOREIGN KEY ("fileUploadId") REFERENCES "FileUpload"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DesignMedia"
ADD CONSTRAINT "DesignMedia_legacyCollectionMediaId_fkey"
FOREIGN KEY ("legacyCollectionMediaId") REFERENCES "CollectionMedia"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DesignDraftSession"
ADD CONSTRAINT "DesignDraftSession_designId_fkey"
FOREIGN KEY ("designId") REFERENCES "Design"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesignDraftSession"
ADD CONSTRAINT "DesignDraftSession_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesignDraftSession"
ADD CONSTRAINT "DesignDraftSession_legacyCollectionDraftSessionId_fkey"
FOREIGN KEY ("legacyCollectionDraftSessionId") REFERENCES "CollectionDraftSession"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EntityFilter"
ADD CONSTRAINT "EntityFilter_designId_fkey"
FOREIGN KEY ("designId") REFERENCES "Design"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
