import { PrismaClient, UserType, OrderStatus, PaymentStatus, PayoutStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding Brand Dashboard data...');

    // 1. Create or find a Brand User
    const brandEmail = 'brand@example.com';
    let user = await prisma.user.findUnique({ where: { email: brandEmail } });

    if (!user) {
        user = await prisma.user.create({
            data: {
                id: randomUUID(),
                email: brandEmail,
                username: 'brand_demo',
                firstName: 'Demo',
                lastName: 'Brand',
                password: 'password123', // In real app, hash this
                type: UserType.BRAND,
                isActive: 'Active',
            },
        });
        console.log('Created Brand User:', user.id);
    } else {
        console.log('Found Brand User:', user.id);
    }

    // 2. Create Brand
    let brand = await prisma.brand.findUnique({ where: { ownerId: user.id } });
    if (!brand) {
        brand = await prisma.brand.create({
            data: {
                id: randomUUID(),
                name: 'Vogue Vendor',
                ownerId: user.id,
                description: 'Premium fashion for the modern era.',
                currency: 'NGN',
            },
        });
        console.log('Created Brand:', brand.id);
    } else {
        console.log('Found Brand:', brand.id);
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
        await prisma.$disconnect();
    });
