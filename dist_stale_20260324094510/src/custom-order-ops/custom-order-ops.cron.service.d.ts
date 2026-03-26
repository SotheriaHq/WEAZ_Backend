import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { PrismaService } from 'src/prisma/prisma.service';
export declare class CustomOrderOpsCronService {
    private readonly prisma;
    private readonly sideEffects;
    private readonly refundService;
    private readonly logger;
    constructor(prisma: PrismaService, sideEffects: CustomOrderSideEffectsService, refundService: CustomOrderRefundService);
    processDurableCustomOrderSideEffects(): Promise<void>;
    processAcceptanceSlaRisk(): Promise<void>;
    escalateAcceptanceTimeouts(): Promise<void>;
    remindAcceptanceWindowDeadline(): Promise<void>;
    autoCompleteExpiredAcceptanceWindows(): Promise<void>;
    warnOnStaleProgressStages(): Promise<void>;
    escalatePersistentlyStaleStages(): Promise<void>;
    cleanupExpiredCheckoutIntents(): Promise<void>;
    anonymizeExpiredMeasurements(): Promise<void>;
    queueEligibleCustomOrderPayouts(): Promise<void>;
    private customOrderTarget;
    private adminCustomOrderTarget;
    private notifyBrandOwner;
    private getActiveAdminIds;
    private formatError;
}
