import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PayoutStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PayoutService {
    constructor(private readonly prisma: PrismaService) { }

    async findAll(brandId: string, page = 1, limit = 20) {
        const realBrandId = await this.getBrandId(brandId);
        const skip = (page - 1) * limit;

        const [total, payouts] = await Promise.all([
            this.prisma.payout.count({ where: { brandId: realBrandId } }),
            this.prisma.payout.findMany({
                where: { brandId: realBrandId },
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
            }),
        ]);

        return {
            items: payouts,
            total,
            page,
            totalPages: Math.ceil(total / limit),
        };
    }

    async requestPayout(brandId: string, amount: number) {
        const realBrandId = await this.getBrandId(brandId);

        // Check minimum amount (e.g., 5000)
        if (amount < 5000) {
            throw new BadRequestException('Minimum payout amount is 5000');
        }

        // Check available balance (Mocked: Calculate from paid orders - paid payouts)
        // In a real system, we'd have a 'balance' field on Brand or a Ledger table.
        // For now, we'll just allow it if they have enough sales.

        const totalSales = await this.prisma.order.aggregate({
            where: { brandId: realBrandId, paymentStatus: 'PAID' },
            _sum: { totalAmount: true },
        });

        const totalPayouts = await this.prisma.payout.aggregate({
            where: { brandId: realBrandId, status: { in: ['PAID', 'PROCESSING', 'PENDING'] } },
            _sum: { amount: true },
        });

        const sales = Number(totalSales._sum.totalAmount || 0);
        const paidOut = Number(totalPayouts._sum.amount || 0);
        const balance = sales - paidOut;

        if (amount > balance) {
            throw new BadRequestException(`Insufficient balance. Available: ${balance}`);
        }

        return this.prisma.payout.create({
            data: {
                id: uuidv4(),
                brandId: realBrandId,
                amount,
                status: PayoutStatus.PENDING,
            },
        });
    }

    private async getBrandId(ownerId: string): Promise<string> {
        const brand = await this.prisma.brand.findUnique({
            where: { ownerId },
            select: { id: true },
        });
        if (!brand) throw new NotFoundException('Brand not found');
        return brand.id;
    }
}
