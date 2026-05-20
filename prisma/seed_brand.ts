import {
    BrandMemberRole,
    BrandMemberStatus,
    BrandVerificationStatus,
    CollectionStatus,
    CollectionType,
    CollectionVisibility,
    OrderStatus,
    PaymentStatus,
    PayoutStatus,
    Prisma,
    StorePaymentAccountStatus,
    UserType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { createScriptPrismaClient } from '../scripts/helpers/create-script-prisma';

const scriptPrisma = createScriptPrismaClient();
const prisma = scriptPrisma.prisma;

const seedIds = {
    productOne: '11111111-1111-4111-8111-111111111101',
    productTwo: '11111111-1111-4111-8111-111111111102',
    productThree: '11111111-1111-4111-8111-111111111103',
    collection: '11111111-1111-4111-8111-111111111201',
    actionCollection: '11111111-1111-4111-8111-111111111202',
    collectionProductOne: '11111111-1111-4111-8111-111111111301',
    collectionProductTwo: '11111111-1111-4111-8111-111111111302',
    collectionProductThree: '11111111-1111-4111-8111-111111111303',
};

const productImages = [
    'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=900&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?w=900&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1485968579580-b6d095142e6e?w=900&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1496747611176-843222e1e57c?w=900&auto=format&fit=crop',
];

async function main() {
    console.log('Seeding Brand Dashboard data...');

    // 1. Create or find a Brand User
    const brandEmail = 'brand@example.com';
    const hashedPassword = await argon2.hash('password123');
    let user = await prisma.user.findUnique({ where: { email: brandEmail } });

    if (!user) {
        user = await prisma.user.create({
            data: {
                id: randomUUID(),
                email: brandEmail,
                username: 'brand_demo',
                password: hashedPassword,
                type: UserType.BRAND,
                isActive: 'Active',
                isEmailVerified: true,
                userProfile: {
                    create: {
                        firstName: 'Demo',
                        lastName: 'Brand',
                    },
                },
            },
        });
        console.log('Created Brand User:', user.id);
    } else {
        console.log('Found Brand User:', user.id);
        user = await prisma.user.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                type: UserType.BRAND,
                isActive: 'Active',
                isEmailVerified: true,
            },
        });
        await prisma.userProfile.upsert({
            where: { userId: user.id },
            update: {
                firstName: 'Demo',
                lastName: 'Brand',
            },
            create: {
                userId: user.id,
                firstName: 'Demo',
                lastName: 'Brand',
            },
        });
    }

    // 2. Create Brand
    let brand = await prisma.brand.findUnique({ where: { ownerId: user.id } });
    if (!brand) {
        brand = await prisma.brand.create({
            data: {
                id: randomUUID(),
                name: 'Vogue Vendor',
                ownerId: user.id,
                description: 'Premium African fashion for modern buyers, weddings, and everyday statement dressing.',
                tagline: 'Modern African fashion',
                tags: ['ankara', 'ready-to-wear', 'occasionwear'],
                country: 'Nigeria',
                state: 'Lagos',
                city: 'Lagos',
                businessType: 'Fashion Brand',
                contactEmail: brandEmail,
                socialInstagram: 'https://instagram.com/voguevendor',
                isStoreOpen: true,
                verificationStatus: BrandVerificationStatus.APPROVED,
                currency: 'NGN',
            },
        });
        console.log('Created Brand:', brand.id);
    } else {
        console.log('Found Brand:', brand.id);
        brand = await prisma.brand.update({
            where: { id: brand.id },
            data: {
                name: 'Vogue Vendor',
                description: 'Premium African fashion for modern buyers, weddings, and everyday statement dressing.',
                tagline: 'Modern African fashion',
                tags: ['ankara', 'ready-to-wear', 'occasionwear'],
                country: 'Nigeria',
                state: 'Lagos',
                city: 'Lagos',
                businessType: 'Fashion Brand',
                contactEmail: brandEmail,
                socialInstagram: 'https://instagram.com/voguevendor',
                isStoreOpen: true,
                verificationStatus: BrandVerificationStatus.APPROVED,
                currency: 'NGN',
            },
        });
    }

    await prisma.brandMember.upsert({
        where: {
            brandId_userId: {
                brandId: brand.id,
                userId: user.id,
            },
        },
        update: {
            role: BrandMemberRole.OWNER,
            status: BrandMemberStatus.ACTIVE,
        },
        create: {
            brandId: brand.id,
            userId: user.id,
            role: BrandMemberRole.OWNER,
            status: BrandMemberStatus.ACTIVE,
        },
    });

    await prisma.storePaymentAccount.upsert({
        where: { brandId: brand.id },
        update: {
            status: StorePaymentAccountStatus.ACTIVE,
            provider: 'PAYSTACK',
            countryCode: 'NG',
            currency: 'NGN',
            businessName: brand.name,
            primaryContactName: 'Demo Brand',
            primaryContactEmail: brandEmail,
            primaryContactPhone: '+2348000000000',
            bankCode: '044',
            bankName: 'Access Bank',
            accountName: 'Vogue Vendor',
            accountNumberEncrypted: 'e2e-seed-account',
            accountNumberLast4: '0000',
            isAccountResolved: true,
            accountResolvedAt: new Date(),
            subaccountActive: true,
            subaccountVerified: true,
            transferRecipientActive: true,
            lastSyncError: null,
        },
        create: {
            brandId: brand.id,
            status: StorePaymentAccountStatus.ACTIVE,
            provider: 'PAYSTACK',
            countryCode: 'NG',
            currency: 'NGN',
            businessName: brand.name,
            primaryContactName: 'Demo Brand',
            primaryContactEmail: brandEmail,
            primaryContactPhone: '+2348000000000',
            bankCode: '044',
            bankName: 'Access Bank',
            accountName: 'Vogue Vendor',
            accountNumberEncrypted: 'e2e-seed-account',
            accountNumberLast4: '0000',
            isAccountResolved: true,
            accountResolvedAt: new Date(),
            subaccountActive: true,
            subaccountVerified: true,
            transferRecipientActive: true,
        },
    });

    await prisma.storePolicy.upsert({
        where: { brandId: brand.id },
        update: {
            shippingRegions: ['NG'],
            processingTime: '3-5 business days',
            shippingMethods: ['standard'],
            returnsAccepted: true,
            returnWindow: '14',
            returnConditions: ['Unused with tags attached'],
            refundMethod: 'original',
            responseTimeSla: '24h',
        },
        create: {
            id: randomUUID(),
            brand: { connect: { id: brand.id } },
            shippingRegions: ['NG'],
            processingTime: '3-5 business days',
            shippingMethods: ['standard'],
            returnsAccepted: true,
            returnWindow: '14',
            returnConditions: ['Unused with tags attached'],
            refundMethod: 'original',
            responseTimeSla: '24h',
        },
    });

    const category = await prisma.collectionCategory.findFirst({
        where: { isActive: true },
        include: { types: { where: { isActive: true }, take: 1 } },
    });
    const categoryId = category?.id ?? null;
    const categoryTypeId = category?.types?.[0]?.id ?? null;

    const staleSeedCollections = await prisma.storeCollection.findMany({
        where: {
            ownerId: user.id,
            id: { notIn: [seedIds.collection, seedIds.actionCollection] },
            OR: [
                { tags: { has: 'e2e-playwright' } },
                { title: { startsWith: 'Test Collection E2E' } },
            ],
        },
        select: { id: true },
    });
    const staleSeedCollectionIds = staleSeedCollections.map((item) => item.id);
    if (staleSeedCollectionIds.length > 0) {
        await prisma.storeCollectionProduct.deleteMany({
            where: { collectionId: { in: staleSeedCollectionIds } },
        });
        await prisma.storeCollection.deleteMany({
            where: { id: { in: staleSeedCollectionIds } },
        });
    }

    const storeCollection = await prisma.storeCollection.upsert({
        where: { id: seedIds.collection },
        update: {
            ownerId: user.id,
            title: 'E2E Studio Capsule',
            description: 'Seeded collection used by Playwright Studio catalog coverage.',
            status: CollectionStatus.PUBLISHED,
            archivedFromStatus: null,
            visibility: CollectionVisibility.PUBLIC,
            type: CollectionType.FEMALE,
            categoryId,
            categoryTypeId,
            deletedAt: null,
            deleteExpiresAt: null,
            isAvailableInStore: true,
            isSystemGenerated: false,
            tags: ['e2e-playwright', 'capsule', 'ankara'],
            minPrice: 35000,
            maxPrice: 55000,
            metadataEditedAt: new Date(),
        },
        create: {
            id: seedIds.collection,
            ownerId: user.id,
            title: 'E2E Studio Capsule',
            description: 'Seeded collection used by Playwright Studio catalog coverage.',
            status: CollectionStatus.PUBLISHED,
            visibility: CollectionVisibility.PUBLIC,
            type: CollectionType.FEMALE,
            categoryId,
            categoryTypeId,
            isAvailableInStore: true,
            isSystemGenerated: false,
            tags: ['e2e-playwright', 'capsule', 'ankara'],
            minPrice: 35000,
            maxPrice: 55000,
            metadataEditedAt: new Date(),
        },
        select: { id: true },
    });

    await prisma.storeCollection.upsert({
        where: { id: seedIds.actionCollection },
        update: {
            ownerId: user.id,
            title: 'E2E Action Collection',
            description: 'Seeded draft collection used by Playwright action menu coverage.',
            status: CollectionStatus.DRAFT,
            archivedFromStatus: null,
            visibility: CollectionVisibility.PUBLIC,
            type: CollectionType.EVERYBODY,
            categoryId,
            categoryTypeId,
            deletedAt: null,
            deleteExpiresAt: null,
            isAvailableInStore: true,
            isSystemGenerated: false,
            tags: ['e2e-playwright', 'actions'],
            minPrice: null,
            maxPrice: null,
            metadataEditedAt: new Date(),
        },
        create: {
            id: seedIds.actionCollection,
            ownerId: user.id,
            title: 'E2E Action Collection',
            description: 'Seeded draft collection used by Playwright action menu coverage.',
            status: CollectionStatus.DRAFT,
            visibility: CollectionVisibility.PUBLIC,
            type: CollectionType.EVERYBODY,
            categoryId,
            categoryTypeId,
            isAvailableInStore: true,
            isSystemGenerated: false,
            tags: ['e2e-playwright', 'actions'],
            metadataEditedAt: new Date(),
        },
    });

    const seededProducts = [
        {
            id: seedIds.productOne,
            name: 'E2E Ankara Wrap Dress',
            slug: 'e2e-ankara-wrap-dress',
            price: 35000,
            stock: 8,
            images: [productImages[0], productImages[1]],
        },
        {
            id: seedIds.productTwo,
            name: 'E2E Lagos Two Piece',
            slug: 'e2e-lagos-two-piece',
            price: 45000,
            stock: 6,
            images: [productImages[2], productImages[3]],
        },
        {
            id: seedIds.productThree,
            name: 'E2E Owambe Gown',
            slug: 'e2e-owambe-gown',
            price: 55000,
            stock: 5,
            images: [productImages[1], productImages[2]],
        },
    ];

    for (const product of seededProducts) {
        await prisma.product.upsert({
            where: { id: product.id },
            update: {
                brandId: brand.id,
                collectionId: storeCollection.id,
                categoryId,
                categoryTypeId,
                name: product.name,
                slug: product.slug,
                description: 'Seeded product used by Playwright Studio catalog coverage.',
                brandNameCache: brand.name,
                currency: 'NGN',
                price: new Prisma.Decimal(product.price),
                images: product.images,
                thumbnail: product.images[0],
                sizes: ['XS', 'S', 'M', 'L', 'XL'],
                sizeStock: { XS: 1, S: 2, M: 2, L: 2, XL: 1 },
                totalStock: product.stock,
                lowStockThreshold: 2,
                tags: ['e2e-playwright', 'ankara', 'ready-to-wear'],
                gender: CollectionType.FEMALE,
                isActive: true,
                archivedAt: null,
                archiveExpiresAt: null,
                deletedAt: null,
                publishAt: null,
            },
            create: {
                id: product.id,
                brandId: brand.id,
                collectionId: storeCollection.id,
                categoryId,
                categoryTypeId,
                name: product.name,
                slug: product.slug,
                description: 'Seeded product used by Playwright Studio catalog coverage.',
                brandNameCache: brand.name,
                currency: 'NGN',
                price: new Prisma.Decimal(product.price),
                images: product.images,
                thumbnail: product.images[0],
                sizes: ['XS', 'S', 'M', 'L', 'XL'],
                sizeStock: { XS: 1, S: 2, M: 2, L: 2, XL: 1 },
                totalStock: product.stock,
                lowStockThreshold: 2,
                tags: ['e2e-playwright', 'ankara', 'ready-to-wear'],
                gender: CollectionType.FEMALE,
                isActive: true,
            },
        });
    }

    const collectionProductIds = [
        seedIds.collectionProductOne,
        seedIds.collectionProductTwo,
        seedIds.collectionProductThree,
    ];
    for (const [index, product] of seededProducts.entries()) {
        await prisma.storeCollectionProduct.upsert({
            where: {
                collectionId_productId: {
                    collectionId: storeCollection.id,
                    productId: product.id,
                },
            },
            update: {
                orderIndex: index,
                isPrimary: index === 0,
            },
            create: {
                id: collectionProductIds[index],
                collectionId: storeCollection.id,
                productId: product.id,
                orderIndex: index,
                isPrimary: index === 0,
            },
        });
    }

    // 3. Create Orders
    const ordersCount = await prisma.order.count({ where: { brandId: brand.id } });
    if (ordersCount === 0) {
        console.log('Creating sample orders...');
        const statuses = [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED];

        for (let i = 0; i < 10; i++) {
            await prisma.order.create({
                data: {
                    id: randomUUID(),
                    brandId: brand.id,
                    customerName: `Customer ${i + 1}`,
                    items: [
                        {
                            productId: randomUUID(),
                            name: `Product ${i + 1}`,
                            qty: Math.floor(Math.random() * 3) + 1,
                            price: (Math.random() * 10000) + 5000,
                            thumbnail: '',
                        },
                    ],
                    totalAmount: (Math.random() * 50000) + 10000,
                    currency: 'NGN',
                    status: statuses[Math.floor(Math.random() * statuses.length)],
                    paymentStatus: PaymentStatus.PAID,
                    createdAt: new Date(Date.now() - Math.floor(Math.random() * 1000000000)), // Random time in past
                },
            });
        }
        console.log('Created 10 sample orders.');
    }

    // 4. Create Payouts
    const payoutsCount = await prisma.payout.count({ where: { brandId: brand.id } });
    if (payoutsCount === 0) {
        console.log('Creating sample payouts...');
        await prisma.payout.create({
            data: {
                id: randomUUID(),
                brandId: brand.id,
                amount: 150000,
                currency: 'NGN',
                status: PayoutStatus.PAID,
                createdAt: new Date(Date.now() - 86400000 * 5),
            }
        });
        console.log('Created sample payout.');
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await scriptPrisma.disconnect();
    });
