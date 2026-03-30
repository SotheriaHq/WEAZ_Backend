import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { FxRateService } from './fx-rate.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import {
  InitializePaymentDto,
  PaymentAttemptStatus,
  PaymentChannel,
  PaymentInitResult,
  PaymentAttemptSummary,
  PaymentNextAction,
  PaymentVerifyResult,
  SimulatePaymentAttemptDto,
  VerifyPaymentDto,
} from './payment.types';

type PaymentAttemptRecord = Awaited<ReturnType<PrismaService['paymentAttempt']['findUnique']>>;

interface GatewayInitializationResult {
  gateway: string;
  status: PaymentAttemptStatus;
  channel?: PaymentChannel;
  callbackUrl?: string;
  authorizationUrl?: string;
  bankAccount?: PaymentInitResult['bankAccount'];
  nextAction?: PaymentNextAction;
  expiresAt?: string;
  responseSnapshot?: Record<string, any>;
}

const TERMINAL_ATTEMPT_STATUSES = new Set<PaymentAttemptStatus>([
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRateService: FxRateService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
  ) {}

  async initializePayment(
    dto: InitializePaymentDto,
    userId: string,
  ): Promise<PaymentInitResult> {
    const reference = `TH-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const orders = await this.prisma.order.findMany({
      where: { id: { in: dto.orderIds }, buyerId: userId },
      select: {
        id: true,
        customerName: true,
        shippingAddress: true,
        items: true,
        totalAmount: true,
        shippingCost: true,
        discountAmount: true,
        currency: true,
      },
    });

    if (!orders.length) {
      throw new BadRequestException('No eligible orders found');
    }

    this.ensureSingleCurrency(orders.map((order) => order.currency));

    const paymentData = this.validatePaymentRequest(dto.paymentMethod, dto.paymentData);
    const amount = orders.reduce(
      (sum, order) => sum + Number(order.totalAmount ?? 0),
      0,
    );
    const currency = orders[0].currency;
    const callbackBaseUrl = this.resolveCallbackBaseUrl(dto.callbackUrl);
    const providerMode = this.getProviderMode();
    const settlementQuote = await this.fxRateService.quoteAndPersist({
      from: currency,
      amount,
      actorId: userId,
    });

    const gatewayResult = await this.initializeGateway(
      dto.paymentMethod,
      reference,
      paymentData,
      amount,
      currency,
      callbackBaseUrl,
    );

    const attempt = await this.prisma.$transaction(async (tx) => {
      const createdAttempt = await tx.paymentAttempt.create({
        data: {
          buyerId: userId,
          provider: gatewayResult.gateway,
          providerMode,
          paymentMethod: dto.paymentMethod,
          channel: gatewayResult.channel,
          status: gatewayResult.status,
          reference,
          callbackUrl: gatewayResult.callbackUrl ?? callbackBaseUrl,
          authorizationUrl: gatewayResult.authorizationUrl,
          amount,
          currency,
          settlementCurrency: this.fxRateService.getBaseCurrency(),
          settlementAmount: settlementQuote.convertedAmount,
          exchangeRateSnapshotId: settlementQuote.snapshot.id,
          orderIds: orders.map((order) => order.id),
          requestSnapshot: paymentData as unknown as Prisma.InputJsonValue,
          responseSnapshot: (gatewayResult.responseSnapshot ?? null) as unknown as Prisma.InputJsonValue,
          nextAction: (gatewayResult.nextAction ?? null) as unknown as Prisma.InputJsonValue,
          bankAccount: (gatewayResult.bankAccount ?? null) as unknown as Prisma.InputJsonValue,
          expiresAt: gatewayResult.expiresAt ? new Date(gatewayResult.expiresAt) : null,
        },
      });

      await tx.order.updateMany({
        where: { id: { in: orders.map((order) => order.id) }, buyerId: userId },
        data: {
          paymentMethod: dto.paymentMethod,
          paymentReference: reference,
          paymentGateway: gatewayResult.gateway,
          paymentStatus: this.mapAttemptStatusToOrderPaymentStatus(gatewayResult.status),
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: createdAttempt.id,
          type: 'INITIALIZED',
          source: providerMode === 'mock' ? 'mock-initialize' : 'initialize',
          payload: {
            paymentMethod: dto.paymentMethod,
            gateway: gatewayResult.gateway,
            channel: gatewayResult.channel,
            status: gatewayResult.status,
          },
        },
      });

      return createdAttempt;
    });

    return {
      paymentAttemptId: attempt.id,
      reference,
      gateway: gatewayResult.gateway,
      status: gatewayResult.status,
      currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? amount),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      channel: gatewayResult.channel,
      callbackUrl: gatewayResult.callbackUrl ?? callbackBaseUrl,
      authorizationUrl: gatewayResult.authorizationUrl,
      bankAccount: gatewayResult.bankAccount,
      nextAction: gatewayResult.nextAction,
    };
  }

  async getPaymentAttemptByReference(
    reference: string,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt || attempt.buyerId !== userId) {
      throw new NotFoundException('Payment attempt not found');
    }

    return this.buildAttemptSummary(attempt, userId);
  }

  async getPaymentAttemptByOrderId(
    orderId: string,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      select: { paymentReference: true },
    });

    if (!order?.paymentReference) {
      throw new NotFoundException('No payment attempt found for this order');
    }

    return this.getPaymentAttemptByReference(order.paymentReference, userId);
  }

  async verifyPayment(
    dto: VerifyPaymentDto,
    userId: string,
  ): Promise<PaymentVerifyResult> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference: dto.reference },
    });

    if (!attempt || attempt.buyerId !== userId) {
      throw new BadRequestException('No payment attempt found for this reference');
    }

    const orders = await this.getOwnedOrdersForAttempt(attempt, userId);
    if (!orders.length) {
      throw new BadRequestException('No orders found for this reference');
    }

    if (attempt.status === 'PAID') {
      return this.buildVerifyResult(attempt, orders, true);
    }

    if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
      return this.buildVerifyResult(attempt, orders, false);
    }

    const nextStatus = this.resolveVerificationStatus(attempt, dto.statusHint);
    const updatedAttempt = await this.applyAttemptStatus(
      attempt.reference,
      userId,
      nextStatus,
      'verify',
      {
        gateway: dto.gateway,
        statusHint: dto.statusHint,
      },
    );

    const refreshedOrders = await this.getOwnedOrdersForAttempt(updatedAttempt, userId);
    return this.buildVerifyResult(
      updatedAttempt,
      refreshedOrders,
      updatedAttempt.status === 'PAID',
    );
  }

  async simulatePaymentAttempt(
    reference: string,
    dto: SimulatePaymentAttemptDto,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    if (!this.isMockMode() || !this.allowPaymentSimulation()) {
      throw new BadRequestException('Payment simulation is not enabled');
    }

    const updatedAttempt = await this.applyAttemptStatus(
      reference,
      userId,
      dto.outcome,
      'simulation',
      { outcome: dto.outcome },
    );

    return this.buildAttemptSummary(updatedAttempt, userId);
  }

  async handleWebhook(gateway: string, payload: Record<string, any>): Promise<void> {
    const reference = payload?.data?.reference ?? payload?.txRef;
    if (!reference) {
      this.logger.warn(`Webhook from ${gateway}: missing reference`);
      return;
    }

    this.logger.log(`Webhook received from ${gateway}: ${reference}`);

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      this.logger.warn(`Webhook from ${gateway}: unknown reference ${reference}`);
      return;
    }

    if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
      return;
    }

    await this.applyAttemptStatus(reference, attempt.buyerId ?? '', 'PAID', 'webhook', payload);
  }

  private async initializeGateway(
    paymentMethod: PaymentMethod,
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    switch (paymentMethod) {
      case PaymentMethod.PAYSTACK:
        return this.initPaystack(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.FLUTTERWAVE:
        return this.initFlutterwave(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.BANK_TRANSFER:
        return this.initBankTransfer(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.PAY_ON_DELIVERY:
        throw new BadRequestException('Pay on delivery is temporarily unavailable');
      default:
        throw new BadRequestException(`Unsupported payment method: ${paymentMethod}`);
    }
  }

  private async initPaystack(
    reference: string,
    paymentData: Record<string, any>,
    _amount: number,
    _currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    const mockReturnStatus = this.resolveMockReturnStatus(paymentData);
    return {
      gateway: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel: 'CARD',
      callbackUrl: callbackBaseUrl,
      authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'PAYSTACK', mockReturnStatus),
      nextAction: {
        type: 'REDIRECT',
        title: 'Continue to Paystack checkout',
        description: 'Card details will be collected on the hosted checkout flow.',
        ctaLabel: 'Continue to Paystack',
        instructions: [
          `Use ${paymentData.email} as the payer email if prompted.`,
          'In mock mode, the return status is simulated through the payment-return route.',
          'The order is not treated as paid until verification confirms success.',
        ],
      },
      responseSnapshot: {
        mockReturnStatus,
      },
    };
  }

  private async initFlutterwave(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    const channel = paymentData.channel as PaymentChannel;
    const mockReturnStatus = this.resolveMockReturnStatus(paymentData);

    if (channel === 'CARD') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'REQUIRES_ACTION',
        channel,
        callbackUrl: callbackBaseUrl,
        authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'FLUTTERWAVE', mockReturnStatus),
        nextAction: {
          type: 'REDIRECT',
          title: 'Continue to Flutterwave checkout',
          description: 'The hosted checkout will simulate card authorization and then return to Threadly.',
          ctaLabel: 'Continue to Flutterwave',
          instructions: [
            `Proceed with ${paymentData.email} as the payer email.`,
            'Mock mode still routes through the same callback flow that live mode will use later.',
            'Verification will mark the payment according to the simulated return status.',
          ],
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'BANK_TRANSFER') {
      return this.buildVirtualAccountResult(reference, 'FLUTTERWAVE', amount, currency, 45, paymentData.email, callbackBaseUrl);
    }

    if (channel === 'BANK_ACCOUNT') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'REQUIRES_ACTION',
        channel,
        callbackUrl: callbackBaseUrl,
        authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'FLUTTERWAVE', mockReturnStatus),
        nextAction: {
          type: 'BANK_ACCOUNT_AUTH',
          title: 'Authorize the bank account payment',
          description: 'This flow simulates issuer-side bank-account authorization before completion.',
          ctaLabel: 'Authorize bank account',
          instructions: [
            `Bank: ${paymentData.bankAccount.bankName}`,
            `Account number: ${paymentData.bankAccount.accountNumber}`,
            'Use the continue action to move through the mock callback flow.',
          ],
          metadata: {
            bankName: String(paymentData.bankAccount.bankName),
            accountNumber: String(paymentData.bankAccount.accountNumber),
          },
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'USSD') {
      const shortReference = String(reference).slice(-4);
      const ussdCode = `*${paymentData.ussd.bankCode}*000*${shortReference}#`;
      return {
        gateway: 'FLUTTERWAVE',
        status: 'PENDING',
        channel,
        callbackUrl: callbackBaseUrl,
        nextAction: {
          type: 'USSD_INSTRUCTIONS',
          title: 'Complete payment with USSD',
          description: 'Dial the generated code and then use the mock simulator if you want to mark the payment outcome.',
          instructions: [
            `Selected bank: ${paymentData.ussd.bankName}`,
            `Dial ${ussdCode} on your phone.`,
            'In mock mode, the order stays pending until you simulate or verify an outcome.',
          ],
          ussdCode,
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'MOBILE_MONEY') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'PENDING',
        channel,
        callbackUrl: callbackBaseUrl,
        nextAction: {
          type: 'MOBILE_MONEY_APPROVAL',
          title: 'Approve the mobile money request',
          description: 'A wallet approval is expected. In mock mode, this remains pending until you simulate or verify an outcome.',
          instructions: [
            `Network: ${paymentData.mobileMoney.networkName}`,
            `Phone: ${paymentData.mobileMoney.phone}`,
            'Use the simulator controls to approve, fail, or expire the request during testing.',
          ],
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    throw new BadRequestException(`Unsupported Flutterwave channel: ${channel}`);
  }

  private async initBankTransfer(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    return this.buildVirtualAccountResult(
      reference,
      'BANK_TRANSFER',
      amount,
      currency,
      60,
      paymentData.senderName,
      callbackBaseUrl,
    );
  }

  private buildVirtualAccountResult(
    reference: string,
    gateway: 'FLUTTERWAVE' | 'BANK_TRANSFER',
    amount: number,
    currency: string,
    expiryMinutes: number,
    accountNameSeed: string,
    callbackBaseUrl: string,
  ): GatewayInitializationResult {
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
    const bankAccount = {
      bankName: gateway === 'FLUTTERWAVE' ? 'Wema Bank' : 'Providus Bank',
      accountNumber: gateway === 'FLUTTERWAVE' ? '7845123098' : '4012568897',
      accountName: `${accountNameSeed || 'Threadly'} - Threadly Checkout`,
      expiresAt: expiresAt.toISOString(),
      amount,
      narration: reference,
    };

    return {
      gateway,
      status: 'PENDING',
      channel: 'BANK_TRANSFER',
      callbackUrl: callbackBaseUrl,
      bankAccount,
      expiresAt: expiresAt.toISOString(),
      nextAction: {
        type: 'BANK_TRANSFER_INSTRUCTIONS',
        title: 'Transfer to the generated virtual account',
        description: 'Use the exact amount and narration below. In mock mode, the payment remains pending until you simulate completion or failure.',
        expiresAt: expiresAt.toISOString(),
        instructions: [
          `Send ${amount.toFixed(2)} ${currency} to the generated account.`,
          `Use ${reference} as the transfer narration/reference.`,
          'Verification and simulation routes use the same durable attempt record as live mode will later use.',
        ],
        metadata: {
          bankName: bankAccount.bankName,
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName,
          amount: amount.toFixed(2),
          narration: reference,
        },
      },
      responseSnapshot: {
        mockReturnStatus: this.resolveMockReturnStatus({ email: accountNameSeed }),
      },
    };
  }

  private async buildAttemptSummary(
    attempt: NonNullable<PaymentAttemptRecord>,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    const orders = await this.getOwnedOrdersForAttempt(attempt, userId);
    if (!orders.length) {
      throw new NotFoundException('No orders found for this payment attempt');
    }

    const firstOrder = orders[0];
    const shippingAddress = this.asObject(firstOrder.shippingAddress);
    const items = orders.flatMap((order) => this.asOrderItems(order.items));
    const subtotal = items.reduce(
      (sum, item) =>
        sum + Number(item.price ?? item.unitPrice ?? 0) * Number(item.quantity ?? 1),
      0,
    );
    const shippingCost = orders.reduce((sum, order) => sum + Number(order.shippingCost ?? 0), 0);
    const discount = orders.reduce((sum, order) => sum + Number(order.discountAmount ?? 0), 0);
    const grandTotal = orders.reduce((sum, order) => sum + Number(order.totalAmount ?? 0), 0);

    return {
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      gateway: attempt.provider,
      providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
      paymentMethod: attempt.paymentMethod,
      status: attempt.status as PaymentAttemptStatus,
      currency: attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(
        attempt.settlementAmount ?? attempt.amount ?? grandTotal,
      ),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      channel: (attempt.channel as PaymentChannel | null) ?? undefined,
      authorizationUrl: attempt.authorizationUrl ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
      paymentData: this.asObject(attempt.requestSnapshot),
      nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
      canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
      canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
      orderIds: orders.map((order) => order.id),
      summary: {
        items: items.map((item) => ({
          name: String(item.name ?? item.productName ?? 'Item'),
          quantity: Number(item.quantity ?? 1),
          price: Number(item.price ?? item.unitPrice ?? 0),
        })),
        subtotal,
        shippingCost,
        discount,
        grandTotal,
        shippingName: String(firstOrder.customerName ?? ''),
        shippingCity: String(shippingAddress.city ?? ''),
        shippingState: String(shippingAddress.state ?? ''),
      },
    };
  }

  private async applyAttemptStatus(
    reference: string,
    userId: string,
    nextStatus: PaymentAttemptStatus,
    source: 'verify' | 'simulation' | 'webhook',
    payload?: Record<string, any>,
  ) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt || (attempt.buyerId && userId && attempt.buyerId !== userId)) {
      throw new NotFoundException('Payment attempt not found');
    }

    if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
      return attempt;
    }

    const now = new Date();
    const settlement = await this.fxRateService.resolveSettlement({
      attempt,
      gateway: attempt.provider,
      payload,
    });
    const linkedOrders =
      nextStatus === 'PAID'
        ? await this.prisma.order.findMany({
            where: {
              paymentReference: reference,
              ...(attempt.buyerId ? { buyerId: attempt.buyerId } : {}),
            },
            select: {
              id: true,
              brandId: true,
              buyerId: true,
            },
            orderBy: { createdAt: 'asc' },
          })
        : [];
    const updatedAttempt = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentAttempt.update({
        where: { reference },
        data: {
          status: nextStatus,
          confirmedAt: nextStatus === 'PAID' ? now : attempt.confirmedAt,
          lastVerifiedAt: now,
          settlementCurrency: settlement.settlementCurrency,
          settlementAmount: settlement.settlementAmount,
          exchangeRateSnapshotId: settlement.exchangeRateSnapshotId,
          failureCode: nextStatus === 'FAILED' ? 'MOCK_FAILURE' : nextStatus,
          failureMessage:
            nextStatus === 'FAILED'
              ? 'Mock payment marked as failed.'
              : nextStatus === 'CANCELLED'
                ? 'Mock payment was cancelled.'
                : nextStatus === 'EXPIRED'
                  ? 'Mock payment expired before completion.'
                  : null,
        },
      });

      await tx.order.updateMany({
        where: { paymentReference: reference, buyerId: attempt.buyerId ?? undefined },
        data: {
          paymentStatus: this.mapAttemptStatusToOrderPaymentStatus(nextStatus),
          paidAt: nextStatus === 'PAID' ? now : null,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: updated.id,
          type: `STATUS_${nextStatus}`,
          source,
          payload,
        },
      });

      return updated;
    });

    if (nextStatus === 'PAID' && linkedOrders.length > 0) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByReferences([reference]);
    }

    return updatedAttempt;
  }

  private buildVerifyResult(
    attempt: NonNullable<PaymentAttemptRecord>,
    orders: Array<{
      id: string;
      totalAmount: Prisma.Decimal;
      shippingCost: Prisma.Decimal;
      currency: string;
    }>,
    success: boolean,
  ): PaymentVerifyResult {
    const amount = orders.reduce(
      (sum, order) => sum + Number(order.totalAmount ?? 0),
      0,
    );

    return {
      success,
      status: attempt.status as PaymentAttemptStatus,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      amount,
      currency: orders[0]?.currency ?? attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? amount),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      paidAt: attempt.confirmedAt?.toISOString(),
      channel: attempt.channel ?? undefined,
      gatewayResponse: success
        ? 'Mock payment verified successfully'
        : 'Mock payment remains unresolved or failed',
      failureMessage: attempt.failureMessage ?? undefined,
      orderIds: orders.map((order) => order.id),
    };
  }

  private async getOwnedOrdersForAttempt(
    attempt: NonNullable<PaymentAttemptRecord>,
    userId: string,
  ) {
    return this.prisma.order.findMany({
      where: {
        id: { in: attempt.orderIds },
        buyerId: userId,
      },
      select: {
        id: true,
        customerName: true,
        items: true,
        shippingAddress: true,
        totalAmount: true,
        shippingCost: true,
        discountAmount: true,
        currency: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private validatePaymentRequest(
    paymentMethod: PaymentMethod,
    paymentData?: Record<string, any>,
  ): Record<string, any> {
    if (!paymentData || typeof paymentData !== 'object') {
      throw new BadRequestException('Payment details are required for the selected method');
    }

    const email = String(paymentData.email ?? '').trim();
    const phone = String(paymentData.phone ?? '').trim();
    const consentAccepted = Boolean(paymentData.consentAccepted);

    if (!email) {
      throw new BadRequestException('Customer email is required');
    }
    if (!phone) {
      throw new BadRequestException('Customer phone is required');
    }
    if (!consentAccepted) {
      throw new BadRequestException('Payment consent must be accepted');
    }

    if (!paymentData.billingSameAsShipping && !paymentData.billingAddress) {
      throw new BadRequestException('Billing address is required when different from shipping');
    }

    if (paymentMethod === PaymentMethod.PAYSTACK) {
      if (paymentData.channel !== 'CARD') {
        throw new BadRequestException('Paystack currently supports hosted card checkout only');
      }
      return paymentData;
    }

    if (paymentMethod === PaymentMethod.FLUTTERWAVE) {
      const channel = paymentData.channel as PaymentChannel;
      if (!channel) {
        throw new BadRequestException('Flutterwave payment channel is required');
      }

      if (
        channel === 'BANK_ACCOUNT' &&
        (!paymentData.bankAccount?.bankCode ||
          !paymentData.bankAccount?.accountNumber ||
          !paymentData.bankAccount?.accountName)
      ) {
        throw new BadRequestException(
          'Bank account payments require bank, account number, and account name',
        );
      }

      if (channel === 'USSD') {
        if (!paymentData.ussd?.bankCode || !paymentData.ussd?.bankName) {
          throw new BadRequestException(
            'USSD payments require a supported bank selection',
          );
        }
      }

      if (channel === 'MOBILE_MONEY') {
        if (
          !paymentData.mobileMoney?.countryCode ||
          !paymentData.mobileMoney?.networkId ||
          !paymentData.mobileMoney?.networkName ||
          !paymentData.mobileMoney?.phone
        ) {
          throw new BadRequestException(
            'Mobile money payments require country, network, and phone details',
          );
        }
      }

      return paymentData;
    }

    if (paymentMethod === PaymentMethod.BANK_TRANSFER) {
      if (
        !paymentData.senderName ||
        !paymentData.senderPhone ||
        !paymentData.senderBankName ||
        !paymentData.transferPurpose
      ) {
        throw new BadRequestException(
          'Bank transfer requires sender name, phone, bank name, and payment purpose',
        );
      }
      return paymentData;
    }

    return paymentData;
  }

  private resolveVerificationStatus(
    attempt: NonNullable<PaymentAttemptRecord>,
    statusHint?: string,
  ): PaymentAttemptStatus {
    const normalized = this.normalizeStatusHint(
      statusHint ?? this.asObject(attempt.responseSnapshot)?.mockReturnStatus,
    );

    switch (normalized) {
      case 'PAID':
        return 'PAID';
      case 'FAILED':
        return 'FAILED';
      case 'CANCELLED':
        return 'CANCELLED';
      case 'EXPIRED':
        return 'EXPIRED';
      case 'PROCESSING':
        return 'PROCESSING';
      default:
        return attempt.status as PaymentAttemptStatus;
    }
  }

  private mapAttemptStatusToOrderPaymentStatus(
    status: PaymentAttemptStatus,
  ): PaymentStatus {
    switch (status) {
      case 'PAID':
        return PaymentStatus.PAID;
      case 'FAILED':
      case 'CANCELLED':
      case 'EXPIRED':
        return PaymentStatus.FAILED;
      default:
        return PaymentStatus.PENDING;
    }
  }

  private resolveCallbackBaseUrl(callbackUrl?: string): string {
    const resolved =
      callbackUrl?.trim() ||
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL?.trim() ||
      'http://localhost:5173/checkout/payment-return';

    return resolved;
  }

  private buildMockReturnUrl(
    callbackBaseUrl: string,
    reference: string,
    gateway: string,
    status: string,
  ): string {
    const url = new URL(callbackBaseUrl);
    url.searchParams.set('reference', reference);
    url.searchParams.set('gateway', gateway);
    url.searchParams.set('status', status);
    url.searchParams.set('mode', 'mock');
    return url.toString();
  }

  private getProviderMode(): 'mock' | 'live' {
    return this.isMockMode() ? 'mock' : 'live';
  }

  private isMockMode(): boolean {
    return (process.env.PAYMENTS_MODE ?? 'mock').trim().toLowerCase() !== 'live';
  }

  private allowPaymentSimulation(): boolean {
    return (process.env.ALLOW_PAYMENT_SIMULATION ?? 'true').trim().toLowerCase() === 'true';
  }

  private resolveMockReturnStatus(paymentData: Record<string, any>): string {
    const hint = String(paymentData.mockScenario ?? paymentData.email ?? '').toLowerCase();
    if (hint.includes('fail')) return 'failed';
    if (hint.includes('cancel')) return 'cancelled';
    if (hint.includes('expire')) return 'expired';
    if (hint.includes('pending') || hint.includes('process')) return 'processing';
    return 'success';
  }

  private normalizeStatusHint(value: unknown): PaymentAttemptStatus {
    const normalized = String(value ?? '').trim().toLowerCase();
    switch (normalized) {
      case 'success':
      case 'paid':
        return 'PAID';
      case 'failed':
      case 'fail':
        return 'FAILED';
      case 'cancel':
      case 'cancelled':
        return 'CANCELLED';
      case 'expired':
      case 'expire':
        return 'EXPIRED';
      case 'processing':
      case 'pending':
        return 'PROCESSING';
      default:
        return 'PROCESSING';
    }
  }

  private isTerminalStatus(status: PaymentAttemptStatus): boolean {
    return TERMINAL_ATTEMPT_STATUSES.has(status);
  }

  private ensureSingleCurrency(currencies: string[]) {
    const normalized = Array.from(
      new Set(currencies.map((currency) => String(currency || '').trim().toUpperCase())),
    );

    if (normalized.length > 1) {
      throw new BadRequestException(
        'All orders in a single checkout must use the same currency',
      );
    }
  }

  private asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  private asOrderItems(value: unknown): Array<Record<string, any>> {
    return Array.isArray(value) ? (value as Array<Record<string, any>>) : [];
  }
}
