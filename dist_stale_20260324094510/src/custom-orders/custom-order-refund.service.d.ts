import { CustomOrderActorType, Prisma } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';
interface InitiateCustomOrderRefundParams {
    customOrderId: string;
    reason: string;
    actorType: CustomOrderActorType;
    actorId?: string;
}
export declare class CustomOrderRefundService {
    private readonly ledgerService;
    constructor(ledgerService: LedgerService);
    initiateRefund(tx: Prisma.TransactionClient, params: InitiateCustomOrderRefundParams): Promise<{
        customOrderId: string;
        paymentAttemptId: string;
        reference: string;
        alreadyRefunded: boolean;
    }>;
    private roundMoney;
}
export {};
