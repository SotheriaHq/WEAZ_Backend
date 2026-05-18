import 'dotenv/config';
import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import * as argon2 from 'argon2';
import {
  BrandMemberRole,
  BrandMemberStatus,
  BrandVerificationStatus,
  CollectionType,
  CustomOrderProgressStage,
  CustomOrderSourceType,
  CustomOrderStatus,
  FabricSourcingMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ReviewPromptStatus,
  ReviewSatisfaction,
  ReviewStatus,
  ReviewTargetType,
  Role,
  SizingMode,
  UserStatus,
  UserType,
} from '@prisma/client';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

const PASSWORD = 'Password123!';
const BUYER_EMAIL = 'e2e.reviews.buyer@threadly.test';
const BRAND_EMAIL = 'e2e.reviews.brand@threadly.test';
const ADMIN_EMAIL = 'e2e.reviews.admin@threadly.test';

const ids = {
  buyer: '16e2e000-0000-4000-8000-000000000001',
  brandUser: '16e2e000-0000-4000-8000-000000000002',
  adminUser: '16e2e000-0000-4000-8000-000000000003',
  buyerProfile: '16e2e000-0000-4000-8000-000000000004',
  brandProfile: '16e2e000-0000-4000-8000-000000000005',
  adminProfile: '16e2e000-0000-4000-8000-000000000006',
  brand: '16e2e000-0000-4000-8000-000000000007',
  brandMember: '16e2e000-0000-4000-8000-000000000008',
  fabricBasis: '16e2e000-0000-4000-8000-000000000009',
  customConfig: '16e2e000-0000-4000-8000-000000000010',
  customVersion: '16e2e000-0000-4000-8000-000000000011',
  customOrder: '16e2e000-0000-4000-8000-000000000012',
  standardPromptProduct: '16e2e000-0000-4000-8000-000000000101',
  customPromptProduct: '16e2e000-0000-4000-8000-000000000102',
  editableProduct: '16e2e000-0000-4000-8000-000000000103',
  expiredProduct: '16e2e000-0000-4000-8000-000000000104',
  deletedProduct: '16e2e000-0000-4000-8000-000000000105',
  approvedProduct: '16e2e000-0000-4000-8000-000000000106',
  hiddenProduct: '16e2e000-0000-4000-8000-000000000107',
  flaggedProduct: '16e2e000-0000-4000-8000-000000000108',
  pendingProduct: '16e2e000-0000-4000-8000-000000000109',
  orderStandardPrompt: '16e2e000-0000-4000-8000-000000000201',
  orderEditable: '16e2e000-0000-4000-8000-000000000202',
  orderExpired: '16e2e000-0000-4000-8000-000000000203',
  orderDeleted: '16e2e000-0000-4000-8000-000000000204',
  orderApproved: '16e2e000-0000-4000-8000-000000000205',
  orderHidden: '16e2e000-0000-4000-8000-000000000206',
  orderFlagged: '16e2e000-0000-4000-8000-000000000207',
  orderPending: '16e2e000-0000-4000-8000-000000000208',
  itemStandardPrompt: '16e2e000-0000-4000-8000-000000000301',
  itemEditable: '16e2e000-0000-4000-8000-000000000302',
  itemExpired: '16e2e000-0000-4000-8000-000000000303',
  itemDeleted: '16e2e000-0000-4000-8000-000000000304',
  itemApproved: '16e2e000-0000-4000-8000-000000000305',
  itemHidden: '16e2e000-0000-4000-8000-000000000306',
  itemFlagged: '16e2e000-0000-4000-8000-000000000307',
  itemPending: '16e2e000-0000-4000-8000-000000000308',
  promptStandard: '16e2e000-0000-4000-8000-000000000401',
  promptCustom: '16e2e000-0000-4000-8000-000000000402',
  reviewEditable: '16e2e000-0000-4000-8000-000000000501',
  reviewExpired: '16e2e000-0000-4000-8000-000000000502',
  reviewDeleted: '16e2e000-0000-4000-8000-000000000503',
  reviewProductApproved: '16e2e000-0000-4000-8000-000000000504',
  reviewBrandApproved: '16e2e000-0000-4000-8000-000000000505',
  reviewHidden: '16e2e000-0000-4000-8000-000000000506',
  reviewFlagged: '16e2e000-0000-4000-8000-000000000507',
  reviewPending: '16e2e000-0000-4000-8000-000000000508',
};

const imageUrl = 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b';
const now = new Date();
const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

type PrismaClient = ReturnType<typeof createScriptPrismaClient>['prisma'];

async function upsertUser(
  prisma: PrismaClient,
  input: {
    id: string;
    profileId: string;
    email: string;
    username: string;
    role: Role;
    type: UserType;
    firstName: string;
    lastName: string;
  },
) {
  const password = await argon2.hash(PASSWORD);
  await prisma.$executeRaw`
    INSERT INTO "User" (
      "_id",
      "username",
      "role",
      "type",
      "email",
      "password",
      "isEmailVerified",
      "isActive",
      "status",
      "mustResetPassword",
      "authVersion",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${input.id}::uuid,
      ${input.username},
      ${input.role}::"Role",
      ${input.type}::"UserType",
      ${input.email},
      ${password},
      true,
      'Active',
      ${UserStatus.ACTIVE}::"UserStatus",
      false,
      0,
      now(),
      now()
    )
    ON CONFLICT ("_id") DO UPDATE SET
      "username" = EXCLUDED."username",
      "role" = EXCLUDED."role",
      "type" = EXCLUDED."type",
      "email" = EXCLUDED."email",
      "password" = EXCLUDED."password",
      "isEmailVerified" = true,
      "isActive" = 'Active',
      "status" = EXCLUDED."status",
      "mustResetPassword" = false,
      "updatedAt" = now()
  `;

  await prisma.userProfile.upsert({
    where: { userId: input.id },
    update: {
      firstName: input.firstName,
      lastName: input.lastName,
    },
    create: {
      id: input.profileId,
      userId: input.id,
      firstName: input.firstName,
      lastName: input.lastName,
    },
  });
}

async function seedActors(prisma: PrismaClient) {
  await upsertUser(prisma, {
    id: ids.buyer,
    profileId: ids.buyerProfile,
    email: BUYER_EMAIL,
    username: 'e2e_reviews_buyer',
    role: Role.User,
    type: UserType.REGULAR,
    firstName: 'E2E',
    lastName: 'Reviews Buyer',
  });

  await upsertUser(prisma, {
    id: ids.brandUser,
    profileId: ids.brandProfile,
    email: BRAND_EMAIL,
    username: 'e2e_reviews_brand',
    role: Role.User,
    type: UserType.BRAND,
    firstName: 'E2E',
    lastName: 'Reviews Brand',
  });

  await upsertUser(prisma, {
    id: ids.adminUser,
    profileId: ids.adminProfile,
    email: ADMIN_EMAIL,
    username: 'e2e_reviews_admin',
    role: Role.SuperAdmin,
    type: UserType.REGULAR,
    firstName: 'E2E',
    lastName: 'Reviews Admin',
  });

  await prisma.brand.upsert({
    where: { ownerId: ids.brandUser },
    update: {
      name: 'E2E Reviews Atelier',
      description: 'Deterministic brand for review lifecycle QA.',
      tagline: 'Verified review QA store',
      isStoreOpen: true,
      verificationStatus: BrandVerificationStatus.APPROVED,
      contactEmail: BRAND_EMAIL,
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      currency: 'NGN',
    },
    create: {
      id: ids.brand,
      ownerId: ids.brandUser,
      name: 'E2E Reviews Atelier',
      description: 'Deterministic brand for review lifecycle QA.',
      tagline: 'Verified review QA store',
      isStoreOpen: true,
      verificationStatus: BrandVerificationStatus.APPROVED,
      contactEmail: BRAND_EMAIL,
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      currency: 'NGN',
    },
  });

  await prisma.brandMember.upsert({
    where: { id: ids.brandMember },
    update: {
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    },
    create: {
      id: ids.brandMember,
      brandId: ids.brand,
      userId: ids.brandUser,
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    },
  });
}

async function seedReviewRuntimeControls(prisma: PrismaClient) {
  const flags = [
    ['reviews.v1.admin-moderation', 'Controls admin lifecycle review moderation QA access.', true],
    ['reviews.capture.enabled', 'Controls completed-order lifecycle review capture.', true],
    ['reviews.prompt.afterCompletion.enabled', 'Controls review prompt creation after completed orders.', true],
    ['reviews.publicDisplay.product.enabled', 'Controls public product review display.', true],
    ['reviews.publicDisplay.brand.enabled', 'Controls public brand review display.', true],
    ['reviews.publicDisplay.collection.enabled', 'Controls public collection review display.', false],
    ['reviews.publicDisplay.design.enabled', 'Controls public design review display.', false],
    ['reviews.moderation.required', 'Controls whether new reviews require moderation.', false],
  ] as const;

  for (const [key, description, isEnabled] of flags) {
    await prisma.featureFlag.upsert({
      where: { key },
      update: { description, isEnabled },
      create: {
        id: randomUUID(),
        key,
        description,
        isEnabled,
      },
    });
  }

  await prisma.systemConfig.upsert({
    where: { key: 'reviews.editWindowHours' },
    update: {
      value: '24',
      description: 'Buyer review edit window in hours.',
      updatedById: ids.adminUser,
    },
    create: {
      key: 'reviews.editWindowHours',
      value: '24',
      description: 'Buyer review edit window in hours.',
      updatedById: ids.adminUser,
    },
  });
}

async function seedProducts(prisma: PrismaClient) {
  const products = [
    [ids.standardPromptProduct, 'E2E Reviews Prompt Product', 'e2e-reviews-prompt-product'],
    [ids.customPromptProduct, 'E2E Reviews Custom Prompt Product', 'e2e-reviews-custom-prompt-product'],
    [ids.editableProduct, 'E2E Reviews Editable Product', 'e2e-reviews-editable-product'],
    [ids.expiredProduct, 'E2E Reviews Expired Product', 'e2e-reviews-expired-product'],
    [ids.deletedProduct, 'E2E Reviews Deleted Product', 'e2e-reviews-deleted-product'],
    [ids.approvedProduct, 'E2E Reviews Approved Product', 'e2e-reviews-approved-product'],
    [ids.hiddenProduct, 'E2E Reviews Hidden Product', 'e2e-reviews-hidden-product'],
    [ids.flaggedProduct, 'E2E Reviews Flagged Product', 'e2e-reviews-flagged-product'],
    [ids.pendingProduct, 'E2E Reviews Pending Product', 'e2e-reviews-pending-product'],
  ] as const;

  for (const [id, name, slug] of products) {
    await prisma.product.upsert({
      where: { id },
      update: {
        brandId: ids.brand,
        name,
        slug,
        description: 'Deterministic product for review lifecycle QA.',
        brandNameCache: 'E2E Reviews Atelier',
        price: new Prisma.Decimal('25000'),
        currency: 'NGN',
        standardCheckoutEnabled: true,
        customOrderEnabled: id === ids.customPromptProduct,
        sizingMode: id === ids.customPromptProduct ? SizingMode.CUSTOM : SizingMode.NONE,
        images: [imageUrl],
        thumbnail: imageUrl,
        totalStock: 10,
        trackInventory: true,
        gender: CollectionType.FEMALE,
        isActive: true,
        deletedAt: null,
        archivedAt: null,
        tags: ['e2e', 'reviews'],
      },
      create: {
        id,
        brandId: ids.brand,
        name,
        slug,
        description: 'Deterministic product for review lifecycle QA.',
        brandNameCache: 'E2E Reviews Atelier',
        price: new Prisma.Decimal('25000'),
        currency: 'NGN',
        standardCheckoutEnabled: true,
        customOrderEnabled: id === ids.customPromptProduct,
        sizingMode: id === ids.customPromptProduct ? SizingMode.CUSTOM : SizingMode.NONE,
        images: [imageUrl],
        thumbnail: imageUrl,
        totalStock: 10,
        trackInventory: true,
        gender: CollectionType.FEMALE,
        isActive: true,
        tags: ['e2e', 'reviews'],
      },
    });
  }
}

async function seedCustomOrderInfrastructure(prisma: PrismaClient) {
  await prisma.customFabricRuleBasis.upsert({
    where: { id: ids.fabricBasis },
    update: {
      label: 'E2E Reviews Fabric Rule Basis',
      measurementKeys: [],
      brandId: ids.brand,
    },
    create: {
      id: ids.fabricBasis,
      label: 'E2E Reviews Fabric Rule Basis',
      measurementKeys: [],
      brandId: ids.brand,
    },
  });

  await prisma.customOrderConfiguration.upsert({
    where: {
      sourceType_sourceId: {
        sourceType: CustomOrderSourceType.PRODUCT,
        sourceId: ids.customPromptProduct,
      },
    },
    update: {
      brandId: ids.brand,
      isActive: true,
      title: 'E2E Reviews Custom Product Config',
      requiredMeasurementKeys: [],
      fabricRuleBasisId: ids.fabricBasis,
      baseProductionCharge: new Prisma.Decimal('10000'),
      fabricCostPerYard: new Prisma.Decimal('5000'),
      productionLeadDays: 7,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'Lagos',
      revisionPolicy: 'One revision included',
      returnPolicy: 'Custom order return policy',
      defectPolicy: 'Defects corrected by brand',
      fabricSourcingMode: FabricSourcingMode.BRAND_SOURCED,
      currentVersion: 1,
    },
    create: {
      id: ids.customConfig,
      brandId: ids.brand,
      sourceType: CustomOrderSourceType.PRODUCT,
      sourceId: ids.customPromptProduct,
      isActive: true,
      title: 'E2E Reviews Custom Product Config',
      requiredMeasurementKeys: [],
      fabricRuleBasisId: ids.fabricBasis,
      baseProductionCharge: new Prisma.Decimal('10000'),
      fabricCostPerYard: new Prisma.Decimal('5000'),
      productionLeadDays: 7,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'Lagos',
      revisionPolicy: 'One revision included',
      returnPolicy: 'Custom order return policy',
      defectPolicy: 'Defects corrected by brand',
      fabricSourcingMode: FabricSourcingMode.BRAND_SOURCED,
      currentVersion: 1,
    },
  });

  await prisma.customOrderConfigurationVersion.upsert({
    where: {
      configurationId_version: {
        configurationId: ids.customConfig,
        version: 1,
      },
    },
    update: {
      snapshotJson: {
        title: 'E2E Reviews Custom Product Config',
        baseProductionCharge: 10000,
        fabricCostPerYard: 5000,
      },
      createdById: ids.brandUser,
    },
    create: {
      id: ids.customVersion,
      configurationId: ids.customConfig,
      version: 1,
      snapshotJson: {
        title: 'E2E Reviews Custom Product Config',
        baseProductionCharge: 10000,
        fabricCostPerYard: 5000,
      },
      createdById: ids.brandUser,
    },
  });
}

async function upsertCompletedOrder(
  prisma: PrismaClient,
  input: { orderId: string; orderItemId: string; productId: string; productName: string },
) {
  await prisma.order.upsert({
    where: { id: input.orderId },
    update: {
      brandId: ids.brand,
      buyerId: ids.buyer,
      customerName: 'E2E Reviews Buyer',
      items: [{ productId: input.productId, quantity: 1, price: 25000, name: input.productName }],
      totalAmount: new Prisma.Decimal('25000'),
      currency: 'NGN',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.PAYSTACK,
      paidAt: oneDayAgo,
      deliveredAt: oneDayAgo,
      buyerConfirmedDeliveryAt: oneDayAgo,
    },
    create: {
      id: input.orderId,
      brandId: ids.brand,
      buyerId: ids.buyer,
      customerName: 'E2E Reviews Buyer',
      items: [{ productId: input.productId, quantity: 1, price: 25000, name: input.productName }],
      totalAmount: new Prisma.Decimal('25000'),
      currency: 'NGN',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.PAYSTACK,
      paidAt: oneDayAgo,
      deliveredAt: oneDayAgo,
      buyerConfirmedDeliveryAt: oneDayAgo,
    },
  });

  await prisma.orderItem.upsert({
    where: { id: input.orderItemId },
    update: {
      orderId: input.orderId,
      productId: input.productId,
      brandId: ids.brand,
      buyerId: ids.buyer,
      quantity: 1,
      currency: 'NGN',
      unitPrice: new Prisma.Decimal('25000'),
      totalPrice: new Prisma.Decimal('25000'),
      thumbnailAtPurchase: imageUrl,
      nameAtPurchase: input.productName,
    },
    create: {
      id: input.orderItemId,
      orderId: input.orderId,
      productId: input.productId,
      brandId: ids.brand,
      buyerId: ids.buyer,
      quantity: 1,
      currency: 'NGN',
      unitPrice: new Prisma.Decimal('25000'),
      totalPrice: new Prisma.Decimal('25000'),
      thumbnailAtPurchase: imageUrl,
      nameAtPurchase: input.productName,
    },
  });
}

async function seedOrders(prisma: PrismaClient) {
  const orders = [
    [ids.orderStandardPrompt, ids.itemStandardPrompt, ids.standardPromptProduct, 'E2E Reviews Prompt Product'],
    [ids.orderEditable, ids.itemEditable, ids.editableProduct, 'E2E Reviews Editable Product'],
    [ids.orderExpired, ids.itemExpired, ids.expiredProduct, 'E2E Reviews Expired Product'],
    [ids.orderDeleted, ids.itemDeleted, ids.deletedProduct, 'E2E Reviews Deleted Product'],
    [ids.orderApproved, ids.itemApproved, ids.approvedProduct, 'E2E Reviews Approved Product'],
    [ids.orderHidden, ids.itemHidden, ids.hiddenProduct, 'E2E Reviews Hidden Product'],
    [ids.orderFlagged, ids.itemFlagged, ids.flaggedProduct, 'E2E Reviews Flagged Product'],
    [ids.orderPending, ids.itemPending, ids.pendingProduct, 'E2E Reviews Pending Product'],
  ] as const;

  for (const [orderId, orderItemId, productId, productName] of orders) {
    await upsertCompletedOrder(prisma, { orderId, orderItemId, productId, productName });
  }

  await prisma.customOrder.upsert({
    where: { id: ids.customOrder },
    update: {
      brandId: ids.brand,
      buyerId: ids.buyer,
      sourceType: CustomOrderSourceType.PRODUCT,
      sourceId: ids.customPromptProduct,
      sourceTitleSnapshot: 'E2E Reviews Custom Prompt Product',
      configurationId: ids.customConfig,
      configurationVersionId: ids.customVersion,
      status: CustomOrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.PAYSTACK,
      completedAt: oneDayAgo,
      deliveredAt: oneDayAgo,
      buyerAcceptedAt: oneDayAgo,
    },
    create: {
      id: ids.customOrder,
      brandId: ids.brand,
      buyerId: ids.buyer,
      sourceType: CustomOrderSourceType.PRODUCT,
      sourceId: ids.customPromptProduct,
      sourceTitleSnapshot: 'E2E Reviews Custom Prompt Product',
      sourceSlugSnapshot: 'e2e-reviews-custom-prompt-product',
      sourcePrimaryMediaUrlSnapshot: imageUrl,
      sourceBrandNameSnapshot: 'E2E Reviews Atelier',
      configurationId: ids.customConfig,
      configurationVersionId: ids.customVersion,
      status: CustomOrderStatus.COMPLETED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.PAYSTACK,
      currency: 'NGN',
      baseProductionChargeSnapshot: new Prisma.Decimal('10000'),
      fabricCostPerYardSnapshot: new Prisma.Decimal('5000'),
      computedYards: new Prisma.Decimal('3'),
      internalPriceBreakdownJson: { production: 10000, fabric: 15000 },
      buyerPriceSummaryJson: { currency: 'NGN', grandTotal: 25000 },
      measurementSnapshotJson: { measurements: {} },
      measurementConfirmedAt: oneDayAgo,
      productionLeadDaysSnapshot: 7,
      deliveryMinDaysSnapshot: 2,
      deliveryMaxDaysSnapshot: 5,
      currentProgressStage: CustomOrderProgressStage.READY_FOR_DELIVERY,
      currentProgressStageEnteredAt: oneDayAgo,
      completedAt: oneDayAgo,
      deliveredAt: oneDayAgo,
      buyerAcceptedAt: oneDayAgo,
    },
  });
}

async function seedPrompts(prisma: PrismaClient) {
  await prisma.reviewPrompt.upsert({
    where: { id: ids.promptStandard },
    update: {
      buyerId: ids.buyer,
      brandId: ids.brand,
      orderId: ids.orderStandardPrompt,
      orderItemId: ids.itemStandardPrompt,
      productId: ids.standardPromptProduct,
      targetType: ReviewTargetType.PRODUCT,
      status: ReviewPromptStatus.PENDING,
      shownAt: null,
      skippedAt: null,
      submittedAt: null,
      submittedReviewId: null,
    },
    create: {
      id: ids.promptStandard,
      buyerId: ids.buyer,
      brandId: ids.brand,
      orderId: ids.orderStandardPrompt,
      orderItemId: ids.itemStandardPrompt,
      productId: ids.standardPromptProduct,
      targetType: ReviewTargetType.PRODUCT,
      status: ReviewPromptStatus.PENDING,
    },
  });

  await prisma.reviewPrompt.upsert({
    where: { id: ids.promptCustom },
    update: {
      buyerId: ids.buyer,
      brandId: ids.brand,
      customOrderId: ids.customOrder,
      productId: ids.customPromptProduct,
      targetType: ReviewTargetType.CUSTOM_ORDER,
      status: ReviewPromptStatus.PENDING,
      shownAt: null,
      skippedAt: null,
      submittedAt: null,
      submittedReviewId: null,
    },
    create: {
      id: ids.promptCustom,
      buyerId: ids.buyer,
      brandId: ids.brand,
      customOrderId: ids.customOrder,
      productId: ids.customPromptProduct,
      targetType: ReviewTargetType.CUSTOM_ORDER,
      status: ReviewPromptStatus.PENDING,
    },
  });
}

async function upsertReview(
  prisma: PrismaClient,
  input: {
    id: string;
    orderId?: string;
    orderItemId?: string;
    productId?: string;
    targetType: ReviewTargetType;
    rating: number;
    satisfaction: ReviewSatisfaction;
    reviewText: string;
    status: ReviewStatus;
    createdAt: Date;
    editWindowExpiresAt: Date;
    deleted?: boolean;
    hiddenReason?: string | null;
  },
) {
  await prisma.review.upsert({
    where: { id: input.id },
    update: {
      reviewerId: ids.buyer,
      brandId: ids.brand,
      productId: input.productId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      targetType: input.targetType,
      rating: input.rating,
      satisfaction: input.satisfaction,
      reviewText: input.reviewText,
      verifiedPurchase: true,
      status: input.status,
      editWindowExpiresAt: input.editWindowExpiresAt,
      editedAt: null,
      deletedAt: input.deleted ? oneDayAgo : null,
      deletedById: input.deleted ? ids.buyer : null,
      hiddenReason: input.hiddenReason ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
    create: {
      id: input.id,
      reviewerId: ids.buyer,
      brandId: ids.brand,
      productId: input.productId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      targetType: input.targetType,
      rating: input.rating,
      satisfaction: input.satisfaction,
      reviewText: input.reviewText,
      verifiedPurchase: true,
      status: input.status,
      editWindowExpiresAt: input.editWindowExpiresAt,
      editedAt: null,
      deletedAt: input.deleted ? oneDayAgo : null,
      deletedById: input.deleted ? ids.buyer : null,
      hiddenReason: input.hiddenReason ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  });
}

async function seedReviews(prisma: PrismaClient) {
  await upsertReview(prisma, {
    id: ids.reviewEditable,
    orderId: ids.orderEditable,
    orderItemId: ids.itemEditable,
    productId: ids.editableProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 5,
    satisfaction: ReviewSatisfaction.EXCITED,
    reviewText: 'Editable review still inside the 24-hour window.',
    status: ReviewStatus.APPROVED,
    createdAt: now,
    editWindowExpiresAt: oneHourFromNow,
  });

  await upsertReview(prisma, {
    id: ids.reviewExpired,
    orderId: ids.orderExpired,
    orderItemId: ids.itemExpired,
    productId: ids.expiredProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 4,
    satisfaction: ReviewSatisfaction.HAPPY,
    reviewText: 'Expired review older than the 24-hour edit window.',
    status: ReviewStatus.APPROVED,
    createdAt: twoDaysAgo,
    editWindowExpiresAt: oneDayAgo,
  });

  await upsertReview(prisma, {
    id: ids.reviewDeleted,
    orderId: ids.orderDeleted,
    orderItemId: ids.itemDeleted,
    productId: ids.deletedProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 3,
    satisfaction: ReviewSatisfaction.OKAY,
    reviewText: 'Deleted review retained for audit but hidden publicly.',
    status: ReviewStatus.DELETED,
    createdAt: twoDaysAgo,
    editWindowExpiresAt: oneDayAgo,
    deleted: true,
  });

  await upsertReview(prisma, {
    id: ids.reviewProductApproved,
    orderId: ids.orderApproved,
    orderItemId: ids.itemApproved,
    productId: ids.approvedProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 5,
    satisfaction: ReviewSatisfaction.EXCITED,
    reviewText: 'Approved public product review.',
    status: ReviewStatus.APPROVED,
    createdAt: oneDayAgo,
    editWindowExpiresAt: oneHourFromNow,
  });

  await upsertReview(prisma, {
    id: ids.reviewBrandApproved,
    orderId: ids.orderApproved,
    targetType: ReviewTargetType.BRAND,
    rating: 5,
    satisfaction: ReviewSatisfaction.HAPPY,
    reviewText: 'Approved public brand review.',
    status: ReviewStatus.APPROVED,
    createdAt: oneDayAgo,
    editWindowExpiresAt: oneHourFromNow,
  });

  await upsertReview(prisma, {
    id: ids.reviewHidden,
    orderId: ids.orderHidden,
    orderItemId: ids.itemHidden,
    productId: ids.hiddenProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 1,
    satisfaction: ReviewSatisfaction.ANGRY,
    reviewText: 'Hidden review excluded from public display.',
    status: ReviewStatus.HIDDEN,
    createdAt: oneDayAgo,
    editWindowExpiresAt: oneHourFromNow,
    hiddenReason: 'Seeded hidden review for QA.',
  });

  await upsertReview(prisma, {
    id: ids.reviewFlagged,
    orderId: ids.orderFlagged,
    orderItemId: ids.itemFlagged,
    productId: ids.flaggedProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 2,
    satisfaction: ReviewSatisfaction.SAD,
    reviewText: 'Flagged review for admin moderation QA.',
    status: ReviewStatus.FLAGGED,
    createdAt: oneDayAgo,
    editWindowExpiresAt: oneHourFromNow,
    hiddenReason: 'Seeded flagged review for QA.',
  });

  await upsertReview(prisma, {
    id: ids.reviewPending,
    orderId: ids.orderPending,
    orderItemId: ids.itemPending,
    productId: ids.pendingProduct,
    targetType: ReviewTargetType.PRODUCT,
    rating: 4,
    satisfaction: ReviewSatisfaction.HAPPY,
    reviewText: 'Pending moderation review for admin queue QA.',
    status: ReviewStatus.PENDING_MODERATION,
    createdAt: now,
    editWindowExpiresAt: oneHourFromNow,
  });
}

async function writeSeedDocs() {
  const docPath = resolve(process.cwd(), 'docs', 'reviews-e2e-seed-data.md');
  const content = `# Reviews E2E Seed Data

Generated by \`npm run seed:e2e:reviews\`.

## Test Accounts

| Role | Email | Password | User ID |
| --- | --- | --- | --- |
| Buyer | \`${BUYER_EMAIL}\` | \`${PASSWORD}\` | \`${ids.buyer}\` |
| Brand | \`${BRAND_EMAIL}\` | \`${PASSWORD}\` | \`${ids.brandUser}\` |
| SuperAdmin | \`${ADMIN_EMAIL}\` | \`${PASSWORD}\` | \`${ids.adminUser}\` |

## Seeded Review States

| State | ID |
| --- | --- |
| Pending standard prompt | \`${ids.promptStandard}\` |
| Pending custom prompt | \`${ids.promptCustom}\` |
| Editable review inside 24-hour window | \`${ids.reviewEditable}\` |
| Review older than 24 hours | \`${ids.reviewExpired}\` |
| Soft-deleted review | \`${ids.reviewDeleted}\` |
| Public approved product review | \`${ids.reviewProductApproved}\` |
| Public approved brand review | \`${ids.reviewBrandApproved}\` |
| Hidden review | \`${ids.reviewHidden}\` |
| Flagged review | \`${ids.reviewFlagged}\` |
| Pending moderation review | \`${ids.reviewPending}\` |

## Public QA Targets

| Target | ID |
| --- | --- |
| Brand | \`${ids.brand}\` |
| Product with public approved review | \`${ids.approvedProduct}\` |
| Product with hidden review | \`${ids.hiddenProduct}\` |
| Product with flagged review | \`${ids.flaggedProduct}\` |

Collection/design public reviews remain feature-flagged off by default and are not seeded as public surfaces in this phase.

## Seeded Review Runtime Controls

| Key | Value |
| --- | --- |
| \`reviews.v1.admin-moderation\` | \`true\` |
| \`reviews.capture.enabled\` | \`true\` |
| \`reviews.prompt.afterCompletion.enabled\` | \`true\` |
| \`reviews.publicDisplay.product.enabled\` | \`true\` |
| \`reviews.publicDisplay.brand.enabled\` | \`true\` |
| \`reviews.publicDisplay.collection.enabled\` | \`false\` |
| \`reviews.publicDisplay.design.enabled\` | \`false\` |
| \`reviews.moderation.required\` | \`false\` |
| \`reviews.editWindowHours\` | \`24\` |
`;

  await writeFile(docPath, content, 'utf8');
  return docPath;
}

async function main() {
  const { prisma, disconnect } = createScriptPrismaClient();
  try {
    await seedActors(prisma);
    await seedReviewRuntimeControls(prisma);
    await seedProducts(prisma);
    await seedCustomOrderInfrastructure(prisma);
    await seedOrders(prisma);
    await seedPrompts(prisma);
    await seedReviews(prisma);
    const docPath = await writeSeedDocs();

    console.log('Seeded review lifecycle E2E data.');
    console.log(`Buyer: ${BUYER_EMAIL} / ${PASSWORD}`);
    console.log(`Brand: ${BRAND_EMAIL} / ${PASSWORD}`);
    console.log(`SuperAdmin: ${ADMIN_EMAIL} / ${PASSWORD}`);
    console.log(`Docs: ${docPath}`);
  } finally {
    await disconnect();
  }
}

main().catch((error) => {
  console.error('Failed to seed review lifecycle E2E data');
  console.error(error);
  process.exit(1);
});
