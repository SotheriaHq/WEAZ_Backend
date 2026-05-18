CREATE TYPE "ReviewTargetType" AS ENUM (
  'PRODUCT',
  'COLLECTION',
  'DESIGN',
  'CUSTOM_ORDER',
  'BRAND'
);

CREATE TYPE "ReviewSatisfaction" AS ENUM (
  'NONE',
  'ANGRY',
  'SAD',
  'OKAY',
  'HAPPY',
  'EXCITED'
);

CREATE TYPE "ReviewStatus" AS ENUM (
  'APPROVED',
  'PENDING_MODERATION',
  'HIDDEN',
  'FLAGGED',
  'DELETED'
);

CREATE TYPE "ReviewPromptStatus" AS ENUM (
  'PENDING',
  'SHOWN',
  'SKIPPED',
  'SUBMITTED',
  'EXPIRED'
);

CREATE TABLE "reviews" (
  "id" UUID NOT NULL,
  "reviewerId" UUID NOT NULL,
  "brandId" UUID,
  "productId" UUID,
  "collectionId" UUID,
  "legacyCollectionId" UUID,
  "designId" UUID,
  "orderId" UUID,
  "orderItemId" UUID,
  "customOrderId" UUID,
  "targetType" "ReviewTargetType" NOT NULL,
  "rating" INTEGER NOT NULL,
  "satisfaction" "ReviewSatisfaction" NOT NULL,
  "reviewText" TEXT,
  "verifiedPurchase" BOOLEAN NOT NULL DEFAULT true,
  "status" "ReviewStatus" NOT NULL DEFAULT 'APPROVED',
  "editWindowExpiresAt" TIMESTAMP(3) NOT NULL,
  "editedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "deletedById" UUID,
  "hiddenReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviews_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5)
);

CREATE TABLE "review_prompts" (
  "id" UUID NOT NULL,
  "buyerId" UUID NOT NULL,
  "brandId" UUID,
  "orderId" UUID,
  "orderItemId" UUID,
  "customOrderId" UUID,
  "productId" UUID,
  "collectionId" UUID,
  "legacyCollectionId" UUID,
  "designId" UUID,
  "targetType" "ReviewTargetType" NOT NULL,
  "status" "ReviewPromptStatus" NOT NULL DEFAULT 'PENDING',
  "shownAt" TIMESTAMP(3),
  "skippedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "submittedReviewId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "review_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reviews_reviewerId_orderItemId_targetType_key"
ON "reviews"("reviewerId", "orderItemId", "targetType");

CREATE UNIQUE INDEX "reviews_reviewerId_customOrderId_targetType_key"
ON "reviews"("reviewerId", "customOrderId", "targetType");

CREATE UNIQUE INDEX "reviews_reviewerId_orderId_brandId_targetType_key"
ON "reviews"("reviewerId", "orderId", "brandId", "targetType");

CREATE INDEX "reviews_targetType_status_createdAt_idx"
ON "reviews"("targetType", "status", "createdAt");

CREATE INDEX "reviews_productId_status_createdAt_idx"
ON "reviews"("productId", "status", "createdAt");

CREATE INDEX "reviews_collectionId_status_createdAt_idx"
ON "reviews"("collectionId", "status", "createdAt");

CREATE INDEX "reviews_legacyCollectionId_status_createdAt_idx"
ON "reviews"("legacyCollectionId", "status", "createdAt");

CREATE INDEX "reviews_designId_status_createdAt_idx"
ON "reviews"("designId", "status", "createdAt");

CREATE INDEX "reviews_brandId_status_createdAt_idx"
ON "reviews"("brandId", "status", "createdAt");

CREATE INDEX "reviews_reviewerId_createdAt_idx"
ON "reviews"("reviewerId", "createdAt");

CREATE UNIQUE INDEX "review_prompts_buyerId_orderItemId_targetType_key"
ON "review_prompts"("buyerId", "orderItemId", "targetType");

CREATE UNIQUE INDEX "review_prompts_buyerId_customOrderId_targetType_key"
ON "review_prompts"("buyerId", "customOrderId", "targetType");

CREATE UNIQUE INDEX "review_prompts_buyerId_orderId_brandId_targetType_key"
ON "review_prompts"("buyerId", "orderId", "brandId", "targetType");

CREATE INDEX "review_prompts_buyerId_status_createdAt_idx"
ON "review_prompts"("buyerId", "status", "createdAt");

CREATE INDEX "review_prompts_targetType_status_createdAt_idx"
ON "review_prompts"("targetType", "status", "createdAt");

CREATE INDEX "review_prompts_productId_status_createdAt_idx"
ON "review_prompts"("productId", "status", "createdAt");

CREATE INDEX "review_prompts_collectionId_status_createdAt_idx"
ON "review_prompts"("collectionId", "status", "createdAt");

CREATE INDEX "review_prompts_legacyCollectionId_status_createdAt_idx"
ON "review_prompts"("legacyCollectionId", "status", "createdAt");

CREATE INDEX "review_prompts_designId_status_createdAt_idx"
ON "review_prompts"("designId", "status", "createdAt");

CREATE INDEX "review_prompts_brandId_status_createdAt_idx"
ON "review_prompts"("brandId", "status", "createdAt");

CREATE INDEX "review_prompts_submittedReviewId_idx"
ON "review_prompts"("submittedReviewId");

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_reviewerId_fkey"
FOREIGN KEY ("reviewerId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_legacyCollectionId_fkey"
FOREIGN KEY ("legacyCollectionId") REFERENCES "Collection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_designId_fkey"
FOREIGN KEY ("designId") REFERENCES "Design"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_customOrderId_fkey"
FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reviews"
ADD CONSTRAINT "reviews_deletedById_fkey"
FOREIGN KEY ("deletedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_buyerId_fkey"
FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_orderItemId_fkey"
FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_customOrderId_fkey"
FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_collectionId_fkey"
FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_legacyCollectionId_fkey"
FOREIGN KEY ("legacyCollectionId") REFERENCES "Collection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_designId_fkey"
FOREIGN KEY ("designId") REFERENCES "Design"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "review_prompts"
ADD CONSTRAINT "review_prompts_submittedReviewId_fkey"
FOREIGN KEY ("submittedReviewId") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;
