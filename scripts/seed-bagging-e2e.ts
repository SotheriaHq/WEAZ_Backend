import 'dotenv/config';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import * as argon2 from 'argon2';
import {
  AgeGroup,
  BrandMemberRole,
  BrandMemberStatus,
  BrandVerificationStatus,
  CollectionDomain,
  CollectionStatus,
  CollectionType,
  CollectionVisibility,
  CustomOrderCheckoutStatus,
  CustomOrderProgressStage,
  CustomOrderSourceType,
  CustomOrderStatus,
  FabricSourcingMode,
  FileType,
  FitPreference,
  Gender,
  ImageProcessingStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  SizeFitSharePolicy,
  SizeFitVisibility,
  SizingMode,
  UserStatus,
  UserType,
} from '@prisma/client';
import { seedMeasurementPoints } from '../prisma/seed_measurement_points';
import { createScriptPrismaClient } from './helpers/create-script-prisma';

const BUYER_EMAIL = 'e2e.buyer@threadly.test';
const BRAND_EMAIL = 'e2e.brand@threadly.test';
const PASSWORD = 'Password123!';

const ids = {
  buyerUser: '0e2e0000-0000-4000-8000-000000000001',
  brandUser: '0e2e0000-0000-4000-8000-000000000002',
  buyerProfile: '0e2e0000-0000-4000-8000-000000000003',
  brandProfile: '0e2e0000-0000-4000-8000-000000000004',
  brand: '0e2e0000-0000-4000-8000-000000000005',
  brandMember: '0e2e0000-0000-4000-8000-000000000006',
  sizeFitProfile: '0e2e0000-0000-4000-8000-000000000007',
  fabricBasis: '0e2e0000-0000-4000-8000-000000000008',
  standardProduct: '0e2e0000-0000-4000-8000-000000000101',
  variantProduct: '0e2e0000-0000-4000-8000-000000000102',
  fittingProduct: '0e2e0000-0000-4000-8000-000000000103',
  customDesign: '0e2e0000-0000-4000-8000-000000000104',
  customDesignFile: '0e2e0000-0000-4000-8000-000000000105',
  customDesignMedia: '0e2e0000-0000-4000-8000-000000000106',
  customProduct: '0e2e0000-0000-4000-8000-000000000107',
  staleProduct: '0e2e0000-0000-4000-8000-000000000108',
  duplicateInBagProduct: '0e2e0000-0000-4000-8000-000000000109',
  duplicatePaidActiveProduct: '0e2e0000-0000-4000-8000-000000000110',
  mixedStandardProduct: '0e2e0000-0000-4000-8000-000000000111',
  mixedCustomProduct: '0e2e0000-0000-4000-8000-000000000112',
  variantSmallIndigo: '0e2e0000-0000-4000-8000-000000000201',
  variantMediumGold: '0e2e0000-0000-4000-8000-000000000202',
  mixedCartItem: '0e2e0000-0000-4000-8000-000000000301',
  fittingConfig: '0e2e0000-0000-4000-8000-000000000401',
  fittingVersion: '0e2e0000-0000-4000-8000-000000000402',
  fittingRule: '0e2e0000-0000-4000-8000-000000000403',
  customDesignConfig: '0e2e0000-0000-4000-8000-000000000404',
  customDesignVersion: '0e2e0000-0000-4000-8000-000000000405',
  customDesignRule: '0e2e0000-0000-4000-8000-000000000406',
  customProductConfig: '0e2e0000-0000-4000-8000-000000000407',
  customProductVersion: '0e2e0000-0000-4000-8000-000000000408',
  customProductRule: '0e2e0000-0000-4000-8000-000000000409',
  staleConfig: '0e2e0000-0000-4000-8000-000000000410',
  staleVersion: '0e2e0000-0000-4000-8000-000000000411',
  staleRule: '0e2e0000-0000-4000-8000-000000000412',
  duplicateInBagConfig: '0e2e0000-0000-4000-8000-000000000413',
  duplicateInBagVersion: '0e2e0000-0000-4000-8000-000000000414',
  duplicateInBagRule: '0e2e0000-0000-4000-8000-000000000415',
  duplicatePaidConfig: '0e2e0000-0000-4000-8000-000000000416',
  duplicatePaidVersion: '0e2e0000-0000-4000-8000-000000000417',
  duplicatePaidRule: '0e2e0000-0000-4000-8000-000000000418',
  mixedCustomConfig: '0e2e0000-0000-4000-8000-000000000419',
  mixedCustomVersion: '0e2e0000-0000-4000-8000-000000000420',
  mixedCustomRule: '0e2e0000-0000-4000-8000-000000000421',
  duplicateInBagIntent: '0e2e0000-0000-4000-8000-000000000501',
  duplicateInBagSession: '0e2e0000-0000-4000-8000-000000000502',
  mixedCustomIntent: '0e2e0000-0000-4000-8000-000000000503',
  mixedCustomSession: '0e2e0000-0000-4000-8000-000000000504',
  duplicatePaidOrder: '0e2e0000-0000-4000-8000-000000000505',
};

const imageUrl = 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b';
const staleUpdatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const futureExpiry = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const staleMeasurements = {
  WOMEN_WAIST: { value: 76, unit: 'CM' },
  WOMEN_HIP: { value: 102, unit: 'CM' },
};

type ProductSeed = {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: string;
  totalStock: number;
  standardCheckoutEnabled?: boolean;
  customOrderEnabled?: boolean;
  sizes?: string[];
  colors?: string[];
  sizingMode?: SizingMode;
  customMeasurementKeys?: string[];
};

type CustomConfigurationSeed = {
  configurationId: string;
  versionId: string;
  ruleId: string;
  sourceType: CustomOrderSourceType;
  sourceId: string;
  title: string;
  requiredMeasurementKeys: string[];
};

const productSeeds: ProductSeed[] = [
  {
    id: ids.standardProduct,
    name: 'E2E Bagging Standard Wrap Top',
    slug: 'e2e-bagging-standard-wrap-top',
    description: 'Deterministic standard product for bagging E2E coverage.',
    price: '12500',
    totalStock: 12,
  },
  {
    id: ids.variantProduct,
    name: 'E2E Bagging Variant Aso Oke Set',
    slug: 'e2e-bagging-variant-aso-oke-set',
    description: 'Deterministic size and color product for bagging E2E coverage.',
    price: '28500',
    totalStock: 8,
    sizes: ['S', 'M'],
    colors: ['Indigo', 'Gold'],
  },
  {
    id: ids.fittingProduct,
    name: 'E2E Bagging Missing Fittings Dress',
    slug: 'e2e-bagging-missing-fittings-dress',
    description: 'Deterministic custom product that requires missing fitting measurements.',
    price: '42000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
    customMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_SHOULDER_WIDTH'],
  },
  {
    id: ids.customProduct,
    name: 'E2E Bagging Custom Product Boubou',
    slug: 'e2e-bagging-custom-product-boubou',
    description: 'Deterministic custom product for direct custom bagging E2E coverage.',
    price: '38000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
  },
  {
    id: ids.staleProduct,
    name: 'E2E Bagging Stale Fittings Kaftan',
    slug: 'e2e-bagging-stale-fittings-kaftan',
    description: 'Deterministic custom product that requires stale buyer measurements.',
    price: '45000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
    customMeasurementKeys: ['WOMEN_WAIST', 'WOMEN_HIP'],
  },
  {
    id: ids.duplicateInBagProduct,
    name: 'E2E Bagging Duplicate In Bag Jumpsuit',
    slug: 'e2e-bagging-duplicate-in-bag-jumpsuit',
    description: 'Deterministic custom product with an existing checkout bag line.',
    price: '52000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
  },
  {
    id: ids.duplicatePaidActiveProduct,
    name: 'E2E Bagging Paid Active Agbada',
    slug: 'e2e-bagging-paid-active-agbada',
    description: 'Deterministic custom product with an active paid custom order.',
    price: '76000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
  },
  {
    id: ids.mixedStandardProduct,
    name: 'E2E Bagging Mixed Checkout Standard Skirt',
    slug: 'e2e-bagging-mixed-checkout-standard-skirt',
    description: 'Deterministic standard product already present in buyer bag.',
    price: '18500',
    totalStock: 5,
  },
  {
    id: ids.mixedCustomProduct,
    name: 'E2E Bagging Mixed Checkout Custom Kimono',
    slug: 'e2e-bagging-mixed-checkout-custom-kimono',
    description: 'Deterministic custom product already present in buyer bag.',
    price: '49000',
    totalStock: 0,
    standardCheckoutEnabled: false,
    customOrderEnabled: true,
    sizingMode: SizingMode.CUSTOM,
  },
];

const customConfigurationSeeds: CustomConfigurationSeed[] = [
  {
    configurationId: ids.fittingConfig,
    versionId: ids.fittingVersion,
    ruleId: ids.fittingRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.fittingProduct,
    title: 'E2E missing fittings configuration',
    requiredMeasurementKeys: ['WOMEN_CHEST_FULL_BUST', 'WOMEN_SHOULDER_WIDTH'],
  },
  {
    configurationId: ids.customDesignConfig,
    versionId: ids.customDesignVersion,
    ruleId: ids.customDesignRule,
    sourceType: CustomOrderSourceType.DESIGN,
    sourceId: ids.customDesign,
    title: 'E2E design custom configuration',
    requiredMeasurementKeys: [],
  },
  {
    configurationId: ids.customProductConfig,
    versionId: ids.customProductVersion,
    ruleId: ids.customProductRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.customProduct,
    title: 'E2E custom product configuration',
    requiredMeasurementKeys: [],
  },
  {
    configurationId: ids.staleConfig,
    versionId: ids.staleVersion,
    ruleId: ids.staleRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.staleProduct,
    title: 'E2E stale fittings configuration',
    requiredMeasurementKeys: ['WOMEN_WAIST', 'WOMEN_HIP'],
  },
  {
    configurationId: ids.duplicateInBagConfig,
    versionId: ids.duplicateInBagVersion,
    ruleId: ids.duplicateInBagRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.duplicateInBagProduct,
    title: 'E2E duplicate in bag configuration',
    requiredMeasurementKeys: [],
  },
  {
    configurationId: ids.duplicatePaidConfig,
    versionId: ids.duplicatePaidVersion,
    ruleId: ids.duplicatePaidRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.duplicatePaidActiveProduct,
    title: 'E2E duplicate paid active configuration',
    requiredMeasurementKeys: [],
  },
  {
    configurationId: ids.mixedCustomConfig,
    versionId: ids.mixedCustomVersion,
    ruleId: ids.mixedCustomRule,
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: ids.mixedCustomProduct,
    title: 'E2E mixed checkout custom configuration',
    requiredMeasurementKeys: [],
  },
];

const priceSummary = {
  currency: 'NGN',
  fabricCharge: 30000,
  productionCharge: 10000,
  rushFee: 0,
  shippingFee: 0,
  subtotal: 40000,
  grandTotal: 40000,
};

const requestSnapshot = (configurationId: string) => ({
  configurationId,
  measurementValues: staleMeasurements,
  rushSelected: false,
  shippingAddress: null,
  contactInfo: null,
  chartLock: {
    pricingChartFamily: 'NIGERIA',
    displayChartFamily: 'NIGERIA',
    resolverPolicy: 'PRIMARY_ONLY',
    chartVersionId: 'e2e-bagging-chart',
    computedSize: null,
    noDirectMatch: false,
    conversionGuidance: null,
    quoteStatus: 'AUTO_PRICED',
  },
});

async function upsertUserWithProfile(
  prisma: ReturnType<typeof createScriptPrismaClient>['prisma'],
  input: {
    userId: string;
    profileId: string;
    email: string;
    username: string;
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
      ${input.userId}::uuid,
      ${input.username},
      ${Role.User}::"Role",
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
    where: { userId: input.userId },
    update: {
      firstName: input.firstName,
      lastName: input.lastName,
    },
    create: {
      id: input.profileId,
      userId: input.userId,
      firstName: input.firstName,
      lastName: input.lastName,
    },
  });
}

async function seedUsersAndBrand(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await upsertUserWithProfile(prisma, {
    userId: ids.buyerUser,
    profileId: ids.buyerProfile,
    email: BUYER_EMAIL,
    username: 'e2e_buyer',
    type: UserType.REGULAR,
    firstName: 'E2E',
    lastName: 'Buyer',
  });

  await upsertUserWithProfile(prisma, {
    userId: ids.brandUser,
    profileId: ids.brandProfile,
    email: BRAND_EMAIL,
    username: 'e2e_brand',
    type: UserType.BRAND,
    firstName: 'E2E',
    lastName: 'Brand',
  });

  await prisma.brand.upsert({
    where: { ownerId: ids.brandUser },
    update: {
      name: 'E2E Bagging Atelier',
      description: 'Deterministic brand store for bagging E2E coverage.',
      tagline: 'Seeded bagging QA store',
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
      name: 'E2E Bagging Atelier',
      description: 'Deterministic brand store for bagging E2E coverage.',
      tagline: 'Seeded bagging QA store',
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

async function seedBuyerMeasurements(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await prisma.userSizeFitProfile.upsert({
    where: { userId: ids.buyerUser },
    update: {
      visibility: SizeFitVisibility.PRIVATE,
      sharePolicy: SizeFitSharePolicy.REQUIRE_PERMISSION,
      requireUpdateEveryDays: 14,
      preferredLengthUnit: 'CM',
      preferredWeightUnit: 'KG',
      fitPreference: FitPreference.REGULAR,
      measurements: staleMeasurements,
      lastUpdatedAt: staleUpdatedAt,
      version: 1,
    },
    create: {
      id: ids.sizeFitProfile,
      userId: ids.buyerUser,
      visibility: SizeFitVisibility.PRIVATE,
      sharePolicy: SizeFitSharePolicy.REQUIRE_PERMISSION,
      requireUpdateEveryDays: 14,
      preferredLengthUnit: 'CM',
      preferredWeightUnit: 'KG',
      fitPreference: FitPreference.REGULAR,
      label: 'E2E Measurements',
      measurements: staleMeasurements,
      lastUpdatedAt: staleUpdatedAt,
      version: 1,
    },
  });
}

async function seedProducts(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  for (const product of productSeeds) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        brandId: ids.brand,
        name: product.name,
        slug: product.slug,
        description: product.description,
        brandNameCache: 'E2E Bagging Atelier',
        price: new Prisma.Decimal(product.price),
        currency: 'NGN',
        standardCheckoutEnabled: product.standardCheckoutEnabled ?? true,
        customOrderEnabled: product.customOrderEnabled ?? false,
        sizes: product.sizes ?? [],
        colors: product.colors ?? [],
        sizingMode: product.sizingMode ?? SizingMode.NONE,
        customGender: product.customMeasurementKeys?.length ? Gender.WOMEN : null,
        customMeasurementKeys: product.customMeasurementKeys ?? [],
        customFreeformPointIds: [],
        fitPreference: product.customMeasurementKeys?.length ? FitPreference.REGULAR : null,
        targetAgeGroup: AgeGroup.ADULT,
        images: [imageUrl],
        thumbnail: imageUrl,
        totalStock: product.totalStock,
        trackInventory: true,
        allowBackorders: false,
        gender: CollectionType.FEMALE,
        isActive: true,
        deletedAt: null,
        archivedAt: null,
        tags: ['e2e', 'bagging'],
      },
      create: {
        id: product.id,
        brandId: ids.brand,
        name: product.name,
        slug: product.slug,
        description: product.description,
        brandNameCache: 'E2E Bagging Atelier',
        price: new Prisma.Decimal(product.price),
        currency: 'NGN',
        standardCheckoutEnabled: product.standardCheckoutEnabled ?? true,
        customOrderEnabled: product.customOrderEnabled ?? false,
        sizes: product.sizes ?? [],
        colors: product.colors ?? [],
        sizingMode: product.sizingMode ?? SizingMode.NONE,
        customGender: product.customMeasurementKeys?.length ? Gender.WOMEN : null,
        customMeasurementKeys: product.customMeasurementKeys ?? [],
        customFreeformPointIds: [],
        fitPreference: product.customMeasurementKeys?.length ? FitPreference.REGULAR : null,
        targetAgeGroup: AgeGroup.ADULT,
        images: [imageUrl],
        thumbnail: imageUrl,
        totalStock: product.totalStock,
        trackInventory: true,
        allowBackorders: false,
        gender: CollectionType.FEMALE,
        isActive: true,
        tags: ['e2e', 'bagging'],
      },
    });
  }

  await prisma.productVariant.upsert({
    where: {
      productId_size_color: {
        productId: ids.variantProduct,
        size: 'S',
        color: 'Indigo',
      },
    },
    update: { stock: 4, sku: 'E2E-BAG-S-INDIGO' },
    create: {
      id: ids.variantSmallIndigo,
      productId: ids.variantProduct,
      size: 'S',
      color: 'Indigo',
      stock: 4,
      sku: 'E2E-BAG-S-INDIGO',
    },
  });

  await prisma.productVariant.upsert({
    where: {
      productId_size_color: {
        productId: ids.variantProduct,
        size: 'M',
        color: 'Gold',
      },
    },
    update: { stock: 4, sku: 'E2E-BAG-M-GOLD' },
    create: {
      id: ids.variantMediumGold,
      productId: ids.variantProduct,
      size: 'M',
      color: 'Gold',
      stock: 4,
      sku: 'E2E-BAG-M-GOLD',
    },
  });
}

async function seedDesign(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await prisma.fileUpload.upsert({
    where: { id: ids.customDesignFile },
    update: {
      userId: ids.brandUser,
      originalName: 'e2e-bagging-custom-design.jpg',
      fileName: 'e2e-bagging-custom-design.jpg',
      s3Key: 'e2e/bagging/custom-design.jpg',
      s3Url: imageUrl,
      fileType: FileType.POST_IMAGE,
      mimeType: 'image/jpeg',
      size: 1024,
      processingStatus: ImageProcessingStatus.READY,
      width: 1200,
      height: 1600,
      isPublic: true,
    },
    create: {
      id: ids.customDesignFile,
      userId: ids.brandUser,
      originalName: 'e2e-bagging-custom-design.jpg',
      fileName: 'e2e-bagging-custom-design.jpg',
      s3Key: 'e2e/bagging/custom-design.jpg',
      s3Url: imageUrl,
      fileType: FileType.POST_IMAGE,
      mimeType: 'image/jpeg',
      size: 1024,
      processingStatus: ImageProcessingStatus.READY,
      width: 1200,
      height: 1600,
      isPublic: true,
    },
  });

  await prisma.collection.upsert({
    where: { id: ids.customDesign },
    update: {
      ownerId: ids.brandUser,
      domain: CollectionDomain.DESIGN,
      title: 'E2E Bagging Custom Design',
      description: 'Deterministic design source for custom bagging E2E coverage.',
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      type: CollectionType.FEMALE,
      isAvailableInStore: false,
      customOrderEnabled: true,
      tags: ['e2e', 'bagging'],
      deletedAt: null,
    },
    create: {
      id: ids.customDesign,
      ownerId: ids.brandUser,
      domain: CollectionDomain.DESIGN,
      title: 'E2E Bagging Custom Design',
      description: 'Deterministic design source for custom bagging E2E coverage.',
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      type: CollectionType.FEMALE,
      isAvailableInStore: false,
      customOrderEnabled: true,
      tags: ['e2e', 'bagging'],
    },
  });

  await prisma.collectionMedia.upsert({
    where: { id: ids.customDesignMedia },
    update: {
      collectionId: ids.customDesign,
      fileUploadId: ids.customDesignFile,
      orderIndex: 0,
      mediaType: FileType.POST_IMAGE,
    },
    create: {
      id: ids.customDesignMedia,
      collectionId: ids.customDesign,
      fileUploadId: ids.customDesignFile,
      orderIndex: 0,
      mediaType: FileType.POST_IMAGE,
    },
  });

  await prisma.collection.update({
    where: { id: ids.customDesign },
    data: { coverMediaId: ids.customDesignMedia },
  });
}

async function seedFabricBasis(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await prisma.customFabricRuleBasis.upsert({
    where: { id: ids.fabricBasis },
    update: {
      brandId: ids.brand,
      label: 'E2E bagging measurements',
      measurementKeys: [
        'WOMEN_CHEST_FULL_BUST',
        'WOMEN_SHOULDER_WIDTH',
        'WOMEN_WAIST',
        'WOMEN_HIP',
      ],
    },
    create: {
      id: ids.fabricBasis,
      brandId: ids.brand,
      label: 'E2E bagging measurements',
      measurementKeys: [
        'WOMEN_CHEST_FULL_BUST',
        'WOMEN_SHOULDER_WIDTH',
        'WOMEN_WAIST',
        'WOMEN_HIP',
      ],
    },
  });
}

async function seedCustomConfiguration(
  prisma: ReturnType<typeof createScriptPrismaClient>['prisma'],
  seed: CustomConfigurationSeed,
) {
  const snapshot = {
    title: seed.title,
    requiredMeasurementKeys: seed.requiredMeasurementKeys,
    baseProductionCharge: '10000',
    fabricCostPerYard: '15000',
    productionLeadDays: 10,
    deliveryMinDays: 2,
    deliveryMaxDays: 5,
  };

  await prisma.customOrderConfiguration.upsert({
    where: {
      sourceType_sourceId: {
        sourceType: seed.sourceType,
        sourceId: seed.sourceId,
      },
    },
    update: {
      brandId: ids.brand,
      isActive: true,
      title: seed.title,
      requiredMeasurementKeys: seed.requiredMeasurementKeys,
      requiredFreeformPointIds: [],
      fabricRuleBasisId: ids.fabricBasis,
      baseProductionCharge: new Prisma.Decimal('10000'),
      fabricCostPerYard: new Prisma.Decimal('15000'),
      rushEnabled: false,
      rushFee: null,
      rushProductionLeadDays: null,
      productionLeadDays: 10,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'Nigeria',
      revisionPolicy: 'One minor revision is included before production starts.',
      returnPolicy: 'Custom orders are returnable only for production defects.',
      defectPolicy: 'Verified defects are repaired or remade by the brand.',
      fabricSourcingMode: FabricSourcingMode.BRAND_SOURCED,
      currentVersion: 1,
    },
    create: {
      id: seed.configurationId,
      brandId: ids.brand,
      sourceType: seed.sourceType,
      sourceId: seed.sourceId,
      isActive: true,
      title: seed.title,
      requiredMeasurementKeys: seed.requiredMeasurementKeys,
      requiredFreeformPointIds: [],
      fabricRuleBasisId: ids.fabricBasis,
      baseProductionCharge: new Prisma.Decimal('10000'),
      fabricCostPerYard: new Prisma.Decimal('15000'),
      rushEnabled: false,
      productionLeadDays: 10,
      deliveryMinDays: 2,
      deliveryMaxDays: 5,
      deliveryScope: 'Nigeria',
      revisionPolicy: 'One minor revision is included before production starts.',
      returnPolicy: 'Custom orders are returnable only for production defects.',
      defectPolicy: 'Verified defects are repaired or remade by the brand.',
      fabricSourcingMode: FabricSourcingMode.BRAND_SOURCED,
      currentVersion: 1,
    },
  });

  await prisma.customOrderConfigurationVersion.upsert({
    where: {
      configurationId_version: {
        configurationId: seed.configurationId,
        version: 1,
      },
    },
    update: {
      snapshotJson: snapshot,
      createdById: ids.brandUser,
    },
    create: {
      id: seed.versionId,
      configurationId: seed.configurationId,
      version: 1,
      snapshotJson: snapshot,
      createdById: ids.brandUser,
    },
  });

  await prisma.customFabricRule.upsert({
    where: { id: seed.ruleId },
    update: {
      configurationId: seed.configurationId,
      priority: 0,
      conditionsJson: { type: 'fallback' },
      outputYards: new Prisma.Decimal('2.00'),
      isFallback: true,
    },
    create: {
      id: seed.ruleId,
      configurationId: seed.configurationId,
      priority: 0,
      conditionsJson: { type: 'fallback' },
      outputYards: new Prisma.Decimal('2.00'),
      isFallback: true,
    },
  });
}

async function resetMutableBuyerBagState(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  const seededConfigIds = customConfigurationSeeds.map((seed) => seed.configurationId);
  const seededProductIds = productSeeds.map((seed) => seed.id);

  await prisma.customOrderCheckoutSession.deleteMany({
    where: {
      buyerId: ids.buyerUser,
      customOrderId: null,
      checkoutIntent: {
        configurationId: { in: seededConfigIds },
      },
    },
  });

  await prisma.cartItem.deleteMany({
    where: {
      userId: ids.buyerUser,
      productId: { in: seededProductIds },
    },
  });

  await prisma.customOrder.deleteMany({
    where: {
      id: ids.duplicatePaidOrder,
    },
  });
}

async function upsertCheckoutBagLine(
  prisma: ReturnType<typeof createScriptPrismaClient>['prisma'],
  input: {
    intentId: string;
    sessionId: string;
    configurationId: string;
    configurationVersionId: string;
    previewHash: string;
    resumeToken: string;
    resumePath: string;
  },
) {
  await prisma.customOrderCheckoutIntent.upsert({
    where: { id: input.intentId },
    update: {
      buyerId: ids.buyerUser,
      configurationId: input.configurationId,
      configurationVersionId: input.configurationVersionId,
      currency: 'NGN',
      previewHash: input.previewHash,
      requestSnapshotJson: requestSnapshot(input.configurationId),
      buyerPriceSummaryJson: priceSummary,
      expiresAt: futureExpiry(),
      consumedAt: null,
    },
    create: {
      id: input.intentId,
      buyerId: ids.buyerUser,
      configurationId: input.configurationId,
      configurationVersionId: input.configurationVersionId,
      currency: 'NGN',
      previewHash: input.previewHash,
      requestSnapshotJson: requestSnapshot(input.configurationId),
      buyerPriceSummaryJson: priceSummary,
      expiresAt: futureExpiry(),
    },
  });

  await prisma.customOrderCheckoutSession.upsert({
    where: { id: input.sessionId },
    update: {
      buyerId: ids.buyerUser,
      checkoutIntentId: input.intentId,
      customOrderId: null,
      status: CustomOrderCheckoutStatus.SUBMITTED,
      submittedAt: new Date(),
      resumeToken: input.resumeToken,
      resumePath: input.resumePath,
      uiStateJson: { seededBy: 'seed-bagging-e2e' },
      paymentInitiatedAt: null,
      paidConfirmedAt: null,
      abandonedAt: null,
      lastAttemptId: null,
      lastAttemptReference: null,
      lastAttemptStatus: null,
      attemptsCount: 0,
    },
    create: {
      id: input.sessionId,
      buyerId: ids.buyerUser,
      checkoutIntentId: input.intentId,
      customOrderId: null,
      status: CustomOrderCheckoutStatus.SUBMITTED,
      submittedAt: new Date(),
      resumeToken: input.resumeToken,
      resumePath: input.resumePath,
      uiStateJson: { seededBy: 'seed-bagging-e2e' },
    },
  });
}

async function seedBuyerBagState(prisma: ReturnType<typeof createScriptPrismaClient>['prisma']) {
  await prisma.cartItem.create({
    data: {
      id: ids.mixedCartItem,
      userId: ids.buyerUser,
      productId: ids.mixedStandardProduct,
      quantity: 1,
      sizingMode: SizingMode.NONE,
      requiredMeasurementKeys: [],
    },
  });

  await upsertCheckoutBagLine(prisma, {
    intentId: ids.duplicateInBagIntent,
    sessionId: ids.duplicateInBagSession,
    configurationId: ids.duplicateInBagConfig,
    configurationVersionId: ids.duplicateInBagVersion,
    previewHash: 'e2e-bagging-duplicate-in-bag-preview',
    resumeToken: 'e2e-bagging-duplicate-in-bag-resume',
    resumePath: `/custom-orders/resume/e2e-bagging-duplicate-in-bag-resume`,
  });

  await upsertCheckoutBagLine(prisma, {
    intentId: ids.mixedCustomIntent,
    sessionId: ids.mixedCustomSession,
    configurationId: ids.mixedCustomConfig,
    configurationVersionId: ids.mixedCustomVersion,
    previewHash: 'e2e-bagging-mixed-custom-preview',
    resumeToken: 'e2e-bagging-mixed-custom-resume',
    resumePath: `/custom-orders/resume/e2e-bagging-mixed-custom-resume`,
  });

  await prisma.customOrder.create({
    data: {
      id: ids.duplicatePaidOrder,
      brandId: ids.brand,
      buyerId: ids.buyerUser,
      sourceType: CustomOrderSourceType.PRODUCT,
      sourceId: ids.duplicatePaidActiveProduct,
      sourceTitleSnapshot: 'E2E Bagging Paid Active Agbada',
      sourcePrimaryMediaUrlSnapshot: imageUrl,
      sourceBrandNameSnapshot: 'E2E Bagging Atelier',
      configurationId: ids.duplicatePaidConfig,
      configurationVersionId: ids.duplicatePaidVersion,
      status: CustomOrderStatus.IN_PRODUCTION,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.PAYSTACK,
      paymentReference: 'e2e-bagging-paid-active-reference',
      idempotencyKey: 'e2e-bagging-paid-active-order',
      currency: 'NGN',
      baseProductionChargeSnapshot: new Prisma.Decimal('10000'),
      fabricCostPerYardSnapshot: new Prisma.Decimal('15000'),
      computedYards: new Prisma.Decimal('2.00'),
      internalPriceBreakdownJson: {
        seededBy: 'seed-bagging-e2e',
        fabricCharge: 30000,
        productionCharge: 10000,
      },
      buyerPriceSummaryJson: priceSummary,
      measurementSnapshotJson: staleMeasurements,
      measurementConfirmedAt: staleUpdatedAt,
      rushSelected: false,
      productionLeadDaysSnapshot: 10,
      deliveryMinDaysSnapshot: 2,
      deliveryMaxDaysSnapshot: 5,
      shippingAddressJson: null,
      contactInfoJson: null,
      currentProgressStage: CustomOrderProgressStage.ORDER_PLACED,
      acceptedAt: new Date(),
    },
  });
}

async function writeWebEnvFile() {
  const webEnvPath = resolve(process.cwd(), '..', 'fthreadly', '.env.e2e.bagging');
  const lines = [
    `THREADLY_E2E_BUYER_EMAIL=${BUYER_EMAIL}`,
    `THREADLY_E2E_BUYER_PASSWORD=${PASSWORD}`,
    `THREADLY_E2E_STANDARD_PRODUCT_PATH=/products/${ids.standardProduct}`,
    `THREADLY_E2E_VARIANT_PRODUCT_PATH=/products/${ids.variantProduct}`,
    `THREADLY_E2E_FITTING_PRODUCT_PATH=/products/${ids.fittingProduct}`,
    `THREADLY_E2E_CUSTOM_DESIGN_PATH=/designs/${ids.customDesign}`,
    `THREADLY_E2E_CUSTOM_PRODUCT_PATH=/products/${ids.customProduct}`,
    `THREADLY_E2E_STALE_FITTINGS_PATH=/products/${ids.staleProduct}`,
    `THREADLY_E2E_DUPLICATE_IN_BAG_PATH=/products/${ids.duplicateInBagProduct}`,
    `THREADLY_E2E_DUPLICATE_PAID_ACTIVE_PATH=/products/${ids.duplicatePaidActiveProduct}`,
    'THREADLY_E2E_MIXED_CHECKOUT_PATH=/checkout',
    `THREADLY_E2E_LOGGED_OUT_BAG_PATH=/products/${ids.standardProduct}`,
  ];

  await mkdir(dirname(webEnvPath), { recursive: true });
  await writeFile(webEnvPath, `${lines.join('\n')}\n`, 'utf8');
  return webEnvPath;
}

async function main() {
  const { prisma, disconnect } = createScriptPrismaClient();

  try {
    await seedMeasurementPoints(prisma);
    await seedUsersAndBrand(prisma);
    await seedBuyerMeasurements(prisma);
    await seedProducts(prisma);
    await seedDesign(prisma);
    await seedFabricBasis(prisma);
    for (const seed of customConfigurationSeeds) {
      await seedCustomConfiguration(prisma, seed);
    }
    await resetMutableBuyerBagState(prisma);
    await seedBuyerBagState(prisma);
    const webEnvPath = await writeWebEnvFile();

    console.log('Bagging E2E seed complete.');
    console.log(`Buyer: ${BUYER_EMAIL}`);
    console.log(`Brand: ${BRAND_EMAIL}`);
    console.log(`Products: ${productSeeds.length}`);
    console.log('Custom design source: 1');
    console.log('Seeded existing standard bag lines: 1');
    console.log('Seeded existing custom bag lines: 2');
    console.log('Seeded paid active custom orders: 1');
    console.log(`Web env file: ${webEnvPath}`);
  } finally {
    await disconnect();
  }
}

main().catch((error) => {
  console.error('Bagging E2E seed failed.');
  console.error(error);
  process.exit(1);
});
