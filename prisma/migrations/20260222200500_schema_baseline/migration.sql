-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SuperAdmin', 'Admin', 'User');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('BRAND', 'REGULAR');

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('UNLOCKED', 'LOCKED');

-- CreateEnum
CREATE TYPE "SizeFitVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "SizeFitSharePolicy" AS ENUM ('OWNER_ONLY', 'REQUIRE_PERMISSION', 'ALLOW_ANYONE');

-- CreateEnum
CREATE TYPE "SizeFitShareStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('PROFILE_IMAGE', 'BANNER_IMAGE', 'POST_IMAGE', 'POST_VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "PresignStatus" AS ENUM ('PENDING', 'READY', 'USED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TagEntityType" AS ENUM ('COLLECTION', 'PRODUCT', 'BRAND', 'USER_BRAND');

-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('THREAD', 'DISLIKE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SIGNUP', 'LOGIN', 'COLLECTION_UPLOAD', 'PRODUCT_UPLOAD', 'COLLECTION_DELETED', 'THREAD', 'COMMENT', 'PATCH', 'FOLLOW', 'TAG_MENTION', 'LOGOUT', 'LOGOUT_ALL', 'PRIVATE_ACCESS_REQUESTED', 'PRIVATE_ACCESS_APPROVED', 'PRIVATE_ACCESS_REJECTED', 'PRIVATE_ACCESS_REVOKED', 'BRAND_PATCH_REQUEST', 'BRAND_PATCH_ACCEPTED', 'BRAND_PATCH_REJECTED', 'ORDER_PLACED', 'ORDER_STATUS_UPDATED', 'CONTRIBUTION_REQUEST', 'CONTRIBUTION_ACCEPTED', 'CONTRIBUTION_REJECTED', 'SIZE_FIT_UPDATE_REMINDER', 'SIZE_FIT_SHARED', 'SIZE_FIT_SHARE_REQUEST', 'SIZE_FIT_SHARE_APPROVED', 'SIZE_FIT_SHARE_REJECTED', 'SIZE_FIT_RESHARED');

-- CreateEnum
CREATE TYPE "CommentTarget" AS ENUM ('POST', 'COLLECTION', 'COLLECTION_MEDIA');

-- CreateEnum
CREATE TYPE "CollectionDomain" AS ENUM ('DESIGN', 'STORE');

-- CreateEnum
CREATE TYPE "BulkUploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "BulkUploadRowStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CollectionVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "CollectionType" AS ENUM ('MALE', 'FEMALE', 'EVERYBODY');

-- CreateEnum
CREATE TYPE "CategorySuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AccessState" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PatchMode" AS ENUM ('USER_TO_BRAND', 'BRAND_TO_BRAND');

-- CreateEnum
CREATE TYPE "ContentTarget" AS ENUM ('POST', 'COLLECTION');

-- CreateEnum
CREATE TYPE "PatchStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "SavedItemType" AS ENUM ('COLLECTION', 'COLLECTION_MEDIA');

-- CreateEnum
CREATE TYPE "FilterEntityType" AS ENUM ('COLLECTION', 'STORE_COLLECTION', 'PRODUCT');

-- CreateTable
CREATE TABLE "User" (
    "_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'User',
    "type" "UserType" NOT NULL DEFAULT 'REGULAR',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "address" TEXT,
    "brandFullName" TEXT,
    "cacNumber" TEXT,
    "tin" TEXT,
    "ceoNin" TEXT,
    "ceoFirstName" TEXT,
    "ceoLastName" TEXT,
    "companyLocation" TEXT,
    "brandDescription" TEXT,
    "brandCountry" TEXT,
    "brandState" TEXT,
    "brandCity" TEXT,
    "brandTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brandBusinessType" TEXT,
    "socialInstagram" TEXT,
    "socialFacebook" TEXT,
    "socialTwitter" TEXT,
    "socialWebsite" TEXT,
    "profileImage" TEXT,
    "profileImageId" UUID,
    "bannerImage" TEXT,
    "bannerImageId" UUID,
    "industriNumber" TEXT,
    "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'UNLOCKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerificationCode" TEXT,
    "isActive" TEXT NOT NULL DEFAULT 'Active',
    "notificationSettings" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "FileUpload" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "s3Url" TEXT NOT NULL,
    "fileType" "FileType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileUpload_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Post" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "content" TEXT,
    "imageIds" UUID[],
    "videoId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "_id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "_id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Like" (
    "_id" UUID NOT NULL,
    "postId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CommentV2" (
    "_id" UUID NOT NULL,
    "targetType" "CommentTarget" NOT NULL,
    "targetId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "contentRaw" TEXT NOT NULL,
    "contentSanitized" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CommentV2_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CommentV2Like" (
    "_id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentV2Like_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "_id" UUID NOT NULL,
    "followerId" UUID NOT NULL,
    "followingId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "_id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "domain" "CollectionDomain" NOT NULL DEFAULT 'DESIGN',
    "title" TEXT,
    "description" TEXT,
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
    "pendingCategorySuggestionId" UUID,
    "draftReason" TEXT,
    "pendingCategoryName" TEXT,
    "originalSuggestionId" UUID,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "isAvailableInStore" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "saleMinPrice" DOUBLE PRECISION,
    "saleMaxPrice" DOUBLE PRECISION,
    "saleStartAt" TIMESTAMP(3),
    "saleEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadataEditedAt" TIMESTAMP(3),
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "dislikesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "patchesCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "StoreCollection" (
    "_id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT',
    "archivedFromStatus" "CollectionStatus",
    "visibility" "CollectionVisibility" NOT NULL DEFAULT 'PUBLIC',
    "type" "CollectionType" NOT NULL DEFAULT 'EVERYBODY',
    "categoryId" UUID,
    "categoryTypeId" UUID,
    "deletedAt" TIMESTAMP(3),
    "deleteExpiresAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "isAvailableInStore" BOOLEAN NOT NULL DEFAULT true,
    "isSystemGenerated" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "saleMinPrice" DOUBLE PRECISION,
    "saleMaxPrice" DOUBLE PRECISION,
    "saleStartAt" TIMESTAMP(3),
    "saleEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadataEditedAt" TIMESTAMP(3),
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "dislikesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "patchesCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StoreCollection_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionDraftSession" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "deviceName" TEXT,
    "deviceType" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CollectionDraftSession_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionBulkUploadJob" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "BulkUploadStatus" NOT NULL DEFAULT 'PENDING',
    "mode" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionBulkUploadJob_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionBulkUploadRow" (
    "_id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "rowId" TEXT,
    "status" "BulkUploadRowStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionBulkUploadRow_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionProduct" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionProduct_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "StoreCollectionProduct" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCollectionProduct_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionCategory" (
    "_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCategory_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionCategoryType" (
    "_id" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCategoryType_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionCategorySuggestion" (
    "_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "CategorySuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "proposedByUserId" UUID NOT NULL,
    "decisionByUserId" UUID,
    "rejectionReason" TEXT,
    "approvedCategoryId" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCategorySuggestion_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionAccess" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "state" "AccessState" NOT NULL DEFAULT 'PENDING',
    "grantedBy" UUID,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionAccess_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionMedia" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "fileUploadId" UUID NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "mediaType" "FileType" NOT NULL,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CollectionMedia_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionReaction" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ReactionType" NOT NULL,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionReaction_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionComment" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionComment_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CommentReaction" (
    "_id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CollectionPatch" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "patchingBrandId" UUID NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionPatch_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "PatchConnection" (
    "_id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'ACCEPTED',
    "mode" "PatchMode" NOT NULL DEFAULT 'USER_TO_BRAND',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatchConnection_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "View" (
    "_id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "viewerId" UUID,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "View_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "_id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "actorId" UUID,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB,
    "html" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "UserSizeFitProfile" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "visibility" "SizeFitVisibility" NOT NULL DEFAULT 'PRIVATE',
    "sharePolicy" "SizeFitSharePolicy" NOT NULL DEFAULT 'REQUIRE_PERMISSION',
    "notifyOnShare" BOOLEAN NOT NULL DEFAULT true,
    "requireUpdateEveryDays" INTEGER NOT NULL DEFAULT 14,
    "measurements" JSONB,
    "notes" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSizeFitProfile_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "UserSizeFitRevision" (
    "_id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "measurements" JSONB NOT NULL,
    "changedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSizeFitRevision_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "UserSizeFitShare" (
    "_id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "viewerId" UUID NOT NULL,
    "requestedById" UUID,
    "status" "SizeFitShareStatus" NOT NULL DEFAULT 'PENDING',
    "canReshare" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSizeFitShare_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "PresignedUpload" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "collectionId" UUID,
    "orderIndex" INTEGER,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileType" "FileType" NOT NULL,
    "s3Key" TEXT NOT NULL,
    "size" INTEGER,
    "status" "PresignStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresignedUpload_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "DailyLikeAggregate" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentType" "ContentTarget" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyLikeAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuarantinedLike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "contentType" "ContentTarget" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuarantinedLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionMediaReaction" (
    "_id" UUID NOT NULL,
    "collectionMediaId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "ReactionType" NOT NULL,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionMediaReaction_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "BrandPatch" (
    "_id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "receiverId" UUID NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandPatch_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "ContributionRequest" (
    "_id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContributionRequest_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "storeNameLastChangedAt" TIMESTAMP(3),
    "ownerId" UUID NOT NULL,
    "description" TEXT,
    "tagline" TEXT,
    "logo" TEXT,
    "banner" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contactEmail" TEXT,
    "responseTimeSla" TEXT NOT NULL DEFAULT '24h',
    "socialInstagram" TEXT,
    "socialTwitter" TEXT,
    "socialTiktok" TEXT,
    "socialWebsite" TEXT,
    "isStoreOpen" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "StorePolicy" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "shippingRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "processingTime" TEXT,
    "shippingMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "freeShippingThreshold" DECIMAL(10,2),
    "returnsAccepted" BOOLEAN NOT NULL DEFAULT true,
    "returnWindow" TEXT,
    "returnConditions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refundMethod" TEXT,
    "responseTimeSla" TEXT NOT NULL DEFAULT '24h',
    "sizeChart" JSONB,
    "shippingRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePolicy_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "SystemTag" (
    "_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemTag_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "_id" UUID NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "aliasOfTagId" UUID,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "TagBinding" (
    "_id" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "entityType" "TagEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagBinding_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Order" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "buyerId" UUID,
    "customerName" TEXT NOT NULL,
    "shippingAddress" JSONB,
    "contactInfo" JSONB,
    "sizeFitSnapshot" JSONB,
    "items" JSONB NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "_id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "Product" (
    "_id" UUID NOT NULL,
    "collectionId" UUID,
    "categoryTypeId" UUID,
    "categoryId" UUID,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "price" DECIMAL(10,2) NOT NULL,
    "salePrice" DECIMAL(10,2),
    "saleStartAt" TIMESTAMP(3),
    "saleEndAt" TIMESTAMP(3),
    "sku" TEXT,
    "weight" DECIMAL(10,3),
    "weightUnit" TEXT DEFAULT 'kg',
    "materials" TEXT,
    "careInstructions" TEXT,
    "costPerItem" DECIMAL(10,2),
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sizeStock" JSONB,
    "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colorImages" JSONB,
    "colorHexCodes" JSONB,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "thumbnail" TEXT,
    "totalStock" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "allowBackorders" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gender" "CollectionType" NOT NULL DEFAULT 'EVERYBODY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isPhysicalProduct" BOOLEAN NOT NULL DEFAULT true,
    "customsRegion" TEXT,
    "returnsEligible" BOOLEAN NOT NULL DEFAULT true,
    "metaTitle" TEXT,
    "metaDescription" TEXT,
    "publishAt" TIMESTAMP(3),
    "publishNotifiedAt" TIMESTAMP(3),
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archiveExpiresAt" TIMESTAMP(3),
    "archiveLastReminder" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "_id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "size" TEXT,
    "color" TEXT,
    "sku" TEXT,
    "price" DECIMAL(10,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "colorHex" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseBody" JSONB,
    "statusCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "SavedItem" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetType" "SavedItemType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedItem_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "selectedSize" TEXT,
    "selectedColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "WishlistItem" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "FilterDimension" (
    "_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isMulti" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT[] DEFAULT ARRAY['COLLECTION', 'PRODUCT']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterDimension_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "FilterValue" (
    "_id" UUID NOT NULL,
    "dimensionId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterValue_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "EntityFilter" (
    "_id" UUID NOT NULL,
    "filterValueId" UUID NOT NULL,
    "entityType" "FilterEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "productId" UUID,

    CONSTRAINT "EntityFilter_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "_PostImages" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_PostImages_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_cacNumber_key" ON "User"("cacNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_tin_key" ON "User"("tin");

-- CreateIndex
CREATE UNIQUE INDEX "User_ceoNin_key" ON "User"("ceoNin");

-- CreateIndex
CREATE UNIQUE INDEX "User_industriNumber_key" ON "User"("industriNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailVerificationCode_key" ON "User"("emailVerificationCode");

-- CreateIndex
CREATE UNIQUE INDEX "FileUpload_s3Key_key" ON "FileUpload"("s3Key");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_createdAt_idx" ON "RefreshToken"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Like_clientEventId_key" ON "Like"("clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_postId_userId_key" ON "Like"("postId", "userId");

-- CreateIndex
CREATE INDEX "CommentV2_targetType_targetId_createdAt_idx" ON "CommentV2"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "CommentV2_parentId_createdAt_idx" ON "CommentV2"("parentId", "createdAt");

-- CreateIndex
CREATE INDEX "CommentV2Like_userId_createdAt_idx" ON "CommentV2Like"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentV2Like_commentId_userId_key" ON "CommentV2Like"("commentId", "userId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "Follow"("followerId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "Collection_status_createdAt_idx" ON "Collection"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Collection_status_patchesCount_idx" ON "Collection"("status", "patchesCount");

-- CreateIndex
CREATE INDEX "Collection_status_visibility_createdAt_idx" ON "Collection"("status", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "Collection_status_pendingCategorySuggestionId_idx" ON "Collection"("status", "pendingCategorySuggestionId");

-- CreateIndex
CREATE INDEX "Collection_ownerId_status_createdAt_idx" ON "Collection"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Collection_ownerId_domain_status_createdAt_idx" ON "Collection"("ownerId", "domain", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Collection_categoryTypeId_idx" ON "Collection"("categoryTypeId");

-- CreateIndex
CREATE INDEX "Collection_deletedAt_idx" ON "Collection"("deletedAt");

-- CreateIndex
CREATE INDEX "Collection_deleteExpiresAt_idx" ON "Collection"("deleteExpiresAt");

-- CreateIndex
CREATE INDEX "Collection_lastActivityAt_idx" ON "Collection"("lastActivityAt");

-- CreateIndex
CREATE INDEX "StoreCollection_status_createdAt_idx" ON "StoreCollection"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCollection_status_visibility_createdAt_idx" ON "StoreCollection"("status", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCollection_ownerId_status_createdAt_idx" ON "StoreCollection"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCollection_ownerId_visibility_status_createdAt_idx" ON "StoreCollection"("ownerId", "visibility", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCollection_categoryTypeId_idx" ON "StoreCollection"("categoryTypeId");

-- CreateIndex
CREATE INDEX "StoreCollection_deletedAt_idx" ON "StoreCollection"("deletedAt");

-- CreateIndex
CREATE INDEX "StoreCollection_deleteExpiresAt_idx" ON "StoreCollection"("deleteExpiresAt");

-- CreateIndex
CREATE INDEX "StoreCollection_lastActivityAt_idx" ON "StoreCollection"("lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionDraftSession_sessionToken_key" ON "CollectionDraftSession"("sessionToken");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_collectionId_isActive_idx" ON "CollectionDraftSession"("collectionId", "isActive");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_ownerId_idx" ON "CollectionDraftSession"("ownerId");

-- CreateIndex
CREATE INDEX "CollectionDraftSession_expiresAt_idx" ON "CollectionDraftSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_collectionId_createdAt_idx" ON "CollectionBulkUploadJob"("collectionId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_ownerId_createdAt_idx" ON "CollectionBulkUploadJob"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadJob_status_createdAt_idx" ON "CollectionBulkUploadJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadRow_jobId_status_idx" ON "CollectionBulkUploadRow"("jobId", "status");

-- CreateIndex
CREATE INDEX "CollectionBulkUploadRow_rowId_idx" ON "CollectionBulkUploadRow"("rowId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBulkUploadRow_jobId_rowIndex_key" ON "CollectionBulkUploadRow"("jobId", "rowIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionBulkUploadRow_jobId_rowId_key" ON "CollectionBulkUploadRow"("jobId", "rowId");

-- CreateIndex
CREATE INDEX "CollectionProduct_productId_idx" ON "CollectionProduct"("productId");

-- CreateIndex
CREATE INDEX "CollectionProduct_collectionId_orderIndex_idx" ON "CollectionProduct"("collectionId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionProduct_collectionId_productId_key" ON "CollectionProduct"("collectionId", "productId");

-- CreateIndex
CREATE INDEX "StoreCollectionProduct_productId_idx" ON "StoreCollectionProduct"("productId");

-- CreateIndex
CREATE INDEX "StoreCollectionProduct_collectionId_orderIndex_idx" ON "StoreCollectionProduct"("collectionId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCollectionProduct_collectionId_productId_key" ON "StoreCollectionProduct"("collectionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCategory_slug_key" ON "CollectionCategory"("slug");

-- CreateIndex
CREATE INDEX "CollectionCategory_isActive_order_idx" ON "CollectionCategory"("isActive", "order");

-- CreateIndex
CREATE INDEX "CollectionCategoryType_categoryId_isActive_order_idx" ON "CollectionCategoryType"("categoryId", "isActive", "order");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCategoryType_categoryId_slug_key" ON "CollectionCategoryType"("categoryId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCategorySuggestion_slug_key" ON "CollectionCategorySuggestion"("slug");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_status_createdAt_idx" ON "CollectionCategorySuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_proposedByUserId_createdAt_idx" ON "CollectionCategorySuggestion"("proposedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionCategorySuggestion_slug_status_idx" ON "CollectionCategorySuggestion"("slug", "status");

-- CreateIndex
CREATE INDEX "CollectionAccess_collectionId_state_idx" ON "CollectionAccess"("collectionId", "state");

-- CreateIndex
CREATE INDEX "CollectionAccess_viewerId_state_idx" ON "CollectionAccess"("viewerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionAccess_collectionId_viewerId_key" ON "CollectionAccess"("collectionId", "viewerId");

-- CreateIndex
CREATE INDEX "CollectionReaction_collectionId_idx" ON "CollectionReaction"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionReaction_collectionId_userId_key" ON "CollectionReaction"("collectionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentReaction_commentId_userId_key" ON "CommentReaction"("commentId", "userId");

-- CreateIndex
CREATE INDEX "PatchConnection_targetId_status_idx" ON "PatchConnection"("targetId", "status");

-- CreateIndex
CREATE INDEX "PatchConnection_requesterId_status_idx" ON "PatchConnection"("requesterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PatchConnection_requesterId_targetId_key" ON "PatchConnection"("requesterId", "targetId");

-- CreateIndex
CREATE INDEX "View_collectionId_idx" ON "View"("collectionId");

-- CreateIndex
CREATE INDEX "Notification_recipientId_idx" ON "Notification"("recipientId");

-- CreateIndex
CREATE INDEX "Notification_recipientId_isRead_idx" ON "Notification"("recipientId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitProfile_userId_key" ON "UserSizeFitProfile"("userId");

-- CreateIndex
CREATE INDEX "UserSizeFitProfile_nextReminderAt_idx" ON "UserSizeFitProfile"("nextReminderAt");

-- CreateIndex
CREATE INDEX "UserSizeFitProfile_visibility_sharePolicy_idx" ON "UserSizeFitProfile"("visibility", "sharePolicy");

-- CreateIndex
CREATE INDEX "UserSizeFitRevision_createdById_createdAt_idx" ON "UserSizeFitRevision"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitRevision_profileId_version_key" ON "UserSizeFitRevision"("profileId", "version");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_ownerId_status_createdAt_idx" ON "UserSizeFitShare"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_viewerId_status_createdAt_idx" ON "UserSizeFitShare"("viewerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "UserSizeFitShare_requestedById_status_createdAt_idx" ON "UserSizeFitShare"("requestedById", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSizeFitShare_profileId_viewerId_key" ON "UserSizeFitShare"("profileId", "viewerId");

-- CreateIndex
CREATE UNIQUE INDEX "PresignedUpload_s3Key_key" ON "PresignedUpload"("s3Key");

-- CreateIndex
CREATE INDEX "DailyLikeAggregate_contentType_contentId_idx" ON "DailyLikeAggregate"("contentType", "contentId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyLikeAggregate_contentType_contentId_date_key" ON "DailyLikeAggregate"("contentType", "contentId", "date");

-- CreateIndex
CREATE INDEX "QuarantinedLike_userId_contentType_contentId_idx" ON "QuarantinedLike"("userId", "contentType", "contentId");

-- CreateIndex
CREATE INDEX "CollectionMediaReaction_collectionMediaId_idx" ON "CollectionMediaReaction"("collectionMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionMediaReaction_collectionMediaId_userId_key" ON "CollectionMediaReaction"("collectionMediaId", "userId");

-- CreateIndex
CREATE INDEX "BrandPatch_requesterId_status_idx" ON "BrandPatch"("requesterId", "status");

-- CreateIndex
CREATE INDEX "BrandPatch_receiverId_status_idx" ON "BrandPatch"("receiverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrandPatch_requesterId_receiverId_key" ON "BrandPatch"("requesterId", "receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionRequest_requesterId_collectionId_key" ON "ContributionRequest"("requesterId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_ownerId_key" ON "Brand"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "StorePolicy_brandId_key" ON "StorePolicy"("brandId");

-- CreateIndex
CREATE INDEX "StorePolicy_brandId_idx" ON "StorePolicy"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemTag_tag_key" ON "SystemTag"("tag");

-- CreateIndex
CREATE INDEX "SystemTag_tag_idx" ON "SystemTag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_normalizedName_key" ON "Tag"("normalizedName");

-- CreateIndex
CREATE INDEX "Tag_usageCount_updatedAt_idx" ON "Tag"("usageCount" DESC, "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Tag_isBanned_usageCount_idx" ON "Tag"("isBanned", "usageCount" DESC);

-- CreateIndex
CREATE INDEX "TagBinding_entityType_entityId_idx" ON "TagBinding"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "TagBinding_tagId_createdAt_idx" ON "TagBinding"("tagId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TagBinding_tagId_entityType_entityId_key" ON "TagBinding"("tagId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Order_brandId_idx" ON "Order"("brandId");

-- CreateIndex
CREATE INDEX "Order_brandId_status_idx" ON "Order"("brandId", "status");

-- CreateIndex
CREATE INDEX "Order_buyerId_idx" ON "Order"("buyerId");

-- CreateIndex
CREATE INDEX "Payout_brandId_idx" ON "Payout"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_brandId_idx" ON "Product"("brandId");

-- CreateIndex
CREATE INDEX "Product_brandId_isActive_idx" ON "Product"("brandId", "isActive");

-- CreateIndex
CREATE INDEX "Product_collectionId_idx" ON "Product"("collectionId");

-- CreateIndex
CREATE INDEX "Product_brandId_isFeatured_idx" ON "Product"("brandId", "isFeatured");

-- CreateIndex
CREATE INDEX "Product_createdAt_idx" ON "Product"("createdAt");

-- CreateIndex
CREATE INDEX "Product_slug_idx" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_brandId_createdAt_idx" ON "Product"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_brandId_price_idx" ON "Product"("brandId", "price");

-- CreateIndex
CREATE INDEX "Product_brandId_viewsCount_idx" ON "Product"("brandId", "viewsCount");

-- CreateIndex
CREATE INDEX "Product_isActive_brandId_idx" ON "Product"("isActive", "brandId");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");

-- CreateIndex
CREATE INDEX "Product_categoryTypeId_idx" ON "Product"("categoryTypeId");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_stock_idx" ON "ProductVariant"("productId", "stock");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_size_color_key" ON "ProductVariant"("productId", "size", "color");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_userId_createdAt_idx" ON "IdempotencyKey"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_method_path_key" ON "IdempotencyKey"("userId", "key", "method", "path");

-- CreateIndex
CREATE INDEX "SavedItem_userId_createdAt_idx" ON "SavedItem"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SavedItem_targetType_targetId_idx" ON "SavedItem"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedItem_userId_targetType_targetId_key" ON "SavedItem"("userId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "CartItem_userId_idx" ON "CartItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_userId_productId_selectedSize_selectedColor_key" ON "CartItem"("userId", "productId", "selectedSize", "selectedColor");

-- CreateIndex
CREATE INDEX "WishlistItem_userId_idx" ON "WishlistItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItem_userId_productId_key" ON "WishlistItem"("userId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "FilterDimension_slug_key" ON "FilterDimension"("slug");

-- CreateIndex
CREATE INDEX "FilterDimension_isActive_order_idx" ON "FilterDimension"("isActive", "order");

-- CreateIndex
CREATE INDEX "FilterValue_dimensionId_isActive_order_idx" ON "FilterValue"("dimensionId", "isActive", "order");

-- CreateIndex
CREATE UNIQUE INDEX "FilterValue_dimensionId_slug_key" ON "FilterValue"("dimensionId", "slug");

-- CreateIndex
CREATE INDEX "EntityFilter_entityType_entityId_idx" ON "EntityFilter"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "EntityFilter_filterValueId_idx" ON "EntityFilter"("filterValueId");

-- CreateIndex
CREATE INDEX "EntityFilter_productId_idx" ON "EntityFilter"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityFilter_filterValueId_entityType_entityId_key" ON "EntityFilter"("filterValueId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "_PostImages_B_index" ON "_PostImages"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_profileImageId_fkey" FOREIGN KEY ("profileImageId") REFERENCES "FileUpload"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_bannerImageId_fkey" FOREIGN KEY ("bannerImageId") REFERENCES "FileUpload"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileUpload" ADD CONSTRAINT "FileUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "FileUpload"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2" ADD CONSTRAINT "CommentV2_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommentV2"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Like" ADD CONSTRAINT "CommentV2Like_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Like" ADD CONSTRAINT "CommentV2Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_categoryTypeId_fkey" FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "CollectionMedia"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_pendingCategorySuggestionId_fkey" FOREIGN KEY ("pendingCategorySuggestionId") REFERENCES "CollectionCategorySuggestion"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCollection" ADD CONSTRAINT "StoreCollection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCollection" ADD CONSTRAINT "StoreCollection_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCollection" ADD CONSTRAINT "StoreCollection_categoryTypeId_fkey" FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDraftSession" ADD CONSTRAINT "CollectionDraftSession_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDraftSession" ADD CONSTRAINT "CollectionDraftSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadJob" ADD CONSTRAINT "CollectionBulkUploadJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionBulkUploadRow" ADD CONSTRAINT "CollectionBulkUploadRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CollectionBulkUploadJob"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCollectionProduct" ADD CONSTRAINT "StoreCollectionProduct_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCollectionProduct" ADD CONSTRAINT "StoreCollectionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategoryType" ADD CONSTRAINT "CollectionCategoryType_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_decisionByUserId_fkey" FOREIGN KEY ("decisionByUserId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionCategorySuggestion" ADD CONSTRAINT "CollectionCategorySuggestion_approvedCategoryId_fkey" FOREIGN KEY ("approvedCategoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAccess" ADD CONSTRAINT "CollectionAccess_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAccess" ADD CONSTRAINT "CollectionAccess_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMedia" ADD CONSTRAINT "CollectionMedia_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMedia" ADD CONSTRAINT "CollectionMedia_fileUploadId_fkey" FOREIGN KEY ("fileUploadId") REFERENCES "FileUpload"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionReaction" ADD CONSTRAINT "CollectionReaction_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionReaction" ADD CONSTRAINT "CollectionReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionComment" ADD CONSTRAINT "CollectionComment_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionComment" ADD CONSTRAINT "CollectionComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CollectionComment"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentReaction" ADD CONSTRAINT "CommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPatch" ADD CONSTRAINT "CollectionPatch_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPatch" ADD CONSTRAINT "CollectionPatch_patchingBrandId_fkey" FOREIGN KEY ("patchingBrandId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchConnection" ADD CONSTRAINT "PatchConnection_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatchConnection" ADD CONSTRAINT "PatchConnection_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "View" ADD CONSTRAINT "View_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "View" ADD CONSTRAINT "View_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitProfile" ADD CONSTRAINT "UserSizeFitProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitRevision" ADD CONSTRAINT "UserSizeFitRevision_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitRevision" ADD CONSTRAINT "UserSizeFitRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserSizeFitProfile"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSizeFitShare" ADD CONSTRAINT "UserSizeFitShare_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresignedUpload" ADD CONSTRAINT "PresignedUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMediaReaction" ADD CONSTRAINT "CollectionMediaReaction_collectionMediaId_fkey" FOREIGN KEY ("collectionMediaId") REFERENCES "CollectionMedia"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMediaReaction" ADD CONSTRAINT "CollectionMediaReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandPatch" ADD CONSTRAINT "BrandPatch_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandPatch" ADD CONSTRAINT "BrandPatch_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRequest" ADD CONSTRAINT "ContributionRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRequest" ADD CONSTRAINT "ContributionRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorePolicy" ADD CONSTRAINT "StorePolicy_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_aliasOfTagId_fkey" FOREIGN KEY ("aliasOfTagId") REFERENCES "Tag"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagBinding" ADD CONSTRAINT "TagBinding_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "StoreCollection"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryTypeId_fkey" FOREIGN KEY ("categoryTypeId") REFERENCES "CollectionCategoryType"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "CollectionCategory"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedItem" ADD CONSTRAINT "SavedItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilterValue" ADD CONSTRAINT "FilterValue_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "FilterDimension"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityFilter" ADD CONSTRAINT "EntityFilter_filterValueId_fkey" FOREIGN KEY ("filterValueId") REFERENCES "FilterValue"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityFilter" ADD CONSTRAINT "EntityFilter_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PostImages" ADD CONSTRAINT "_PostImages_A_fkey" FOREIGN KEY ("A") REFERENCES "FileUpload"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PostImages" ADD CONSTRAINT "_PostImages_B_fkey" FOREIGN KEY ("B") REFERENCES "Post"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

