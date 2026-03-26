import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from 'src/payment/payment.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { LedgerService } from 'src/finance/ledger.service';
import { InitializeCustomOrderPaymentDto, VerifyCustomOrderPaymentDto } from './dto/custom-orders.dto';
export declare class CustomOrdersPaymentsService {
    private readonly prisma;
    private readonly paymentService;
    private readonly sideEffects;
    private readonly systemConfigService;
    private readonly ledgerService;
    constructor(prisma: PrismaService, paymentService: PaymentService, sideEffects: CustomOrderSideEffectsService, systemConfigService: SystemConfigService, ledgerService: LedgerService);
    initializePayment(userId: string, customOrderId: string, dto: InitializeCustomOrderPaymentDto): Promise<{
        status: string;
        data: {
            paymentAttemptId: string;
            reference: string;
            gateway: string;
            status: string;
            channel: string;
            callbackUrl: string;
            authorizationUrl: string;
            bankAccount: Record<string, unknown>;
            nextAction: Record<string, unknown>;
        };
    }>;
    verifyPayment(userId: string, customOrderId: string, dto: VerifyCustomOrderPaymentDto): Promise<{
        status: string;
        data: {
            awaitingProviderConfirmation?: boolean;
            recoveryAction?: unknown;
            recoveryMessage?: unknown;
            success: boolean;
            status: string;
            paymentAttemptId: string;
            reference: string;
            amount: number;
            currency: string;
            paidAt: string;
            channel: string;
            failureMessage: string;
            customOrderId: string;
        };
    }>;
    private toInitResult;
    private toVerifyResult;
    private mapAttemptStatusToPaymentStatus;
    private roundMoney;
    private resolveVerifiedAttemptStatus;
    private buildVerificationSnapshot;
    private isPendingVerificationStatus;
    private getFailureState;
    private normalizeAttemptStatus;
    private asObject;
}
