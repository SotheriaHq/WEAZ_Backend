"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrderRefundService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const ledger_service_1 = require("../finance/ledger.service");
let CustomOrderRefundService = class CustomOrderRefundService {
    constructor(ledgerService) {
        this.ledgerService = ledgerService;
    }
    async initiateRefund(tx, params) {
        const order = await tx.customOrder.findUnique({
            where: { id: params.customOrderId },
            select: {
                id: true,
                brandId: true,
                currency: true,
                paymentReference: true,
                paymentStatus: true,
            },
        });
        if (!order) {
            throw new common_1.NotFoundException('Custom order not found');
        }
        const attempt = order.paymentReference
            ? await tx.paymentAttempt.findUnique({ where: { reference: order.paymentReference } })
            : await tx.paymentAttempt.findFirst({
                where: { customOrderId: params.customOrderId },
                orderBy: { createdAt: 'desc' },
            });
        if (!attempt) {
            throw new common_1.BadRequestException('Custom-order refund cannot be initiated without a payment attempt');
        }
        if (attempt.status === 'REFUNDED' && order.paymentStatus === client_1.PaymentStatus.REFUNDED) {
            return {
                customOrderId: order.id,
                paymentAttemptId: attempt.id,
                reference: attempt.reference,
                alreadyRefunded: true,
            };
        }
        if (attempt.status !== 'PAID') {
            throw new common_1.BadRequestException('Custom-order refund can only be initiated for a paid attempt');
        }
        const now = new Date();
        const allocations = await tx.customOrderLedgerAllocation.findMany({
            where: { customOrderId: params.customOrderId },
            select: {
                amount: true,
                commissionAmount: true,
                netBrandAmount: true,
                status: true,
                eligibleAt: true,
                paidOutAt: true,
            },
        });
        const releasedAllocations = allocations.filter((allocation) => allocation.status === client_1.CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
            allocation.status === client_1.CustomOrderLedgerAllocationStatus.PAID_OUT ||
            allocation.eligibleAt !== null ||
            allocation.paidOutAt !== null);
        const releasedCommission = this.roundMoney(releasedAllocations.reduce((sum, allocation) => sum + Number(allocation.commissionAmount), 0));
        const releasedNet = this.roundMoney(releasedAllocations.reduce((sum, allocation) => sum + Number(allocation.netBrandAmount), 0));
        const releasedGross = this.roundMoney(releasedAllocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0));
        const totalAmount = this.roundMoney(Number(attempt.amount));
        const unreleasedGross = this.roundMoney(Math.max(allocations.length > 0 ? totalAmount - releasedGross : totalAmount, 0));
        await tx.paymentAttempt.update({
            where: { reference: attempt.reference },
            data: {
                status: 'REFUNDED',
                lastVerifiedAt: now,
                responseSnapshot: {
                    refundRequestedAt: now.toISOString(),
                    refundReason: params.reason,
                    refundActorType: params.actorType,
                    refundActorId: params.actorId ?? null,
                },
            },
        });
        await tx.paymentEvent.create({
            data: {
                paymentAttemptId: attempt.id,
                type: 'REFUND_REQUESTED',
                source: 'custom-order-refund',
                payload: {
                    subjectType: client_1.PaymentSubjectType.CUSTOM_ORDER,
                    customOrderId: params.customOrderId,
                    reason: params.reason,
                    actorType: params.actorType,
                    actorId: params.actorId ?? null,
                    requestedAt: now.toISOString(),
                },
            },
        });
        if (order.paymentStatus !== client_1.PaymentStatus.REFUNDED) {
            await tx.customOrder.update({
                where: { id: params.customOrderId },
                data: {
                    paymentStatus: client_1.PaymentStatus.REFUNDED,
                },
            });
        }
        await this.ledgerService.postCustomOrderRefund(tx, {
            customOrderId: params.customOrderId,
            brandId: order.brandId,
            currency: order.currency,
            totalAmount,
            releasedCommission,
            releasedNet,
            unreleasedGross,
        });
        return {
            customOrderId: order.id,
            paymentAttemptId: attempt.id,
            reference: attempt.reference,
            alreadyRefunded: false,
        };
    }
    roundMoney(value) {
        return Math.round((value + Number.EPSILON) * 100) / 100;
    }
};
exports.CustomOrderRefundService = CustomOrderRefundService;
exports.CustomOrderRefundService = CustomOrderRefundService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [ledger_service_1.LedgerService])
], CustomOrderRefundService);
//# sourceMappingURL=custom-order-refund.service.js.map