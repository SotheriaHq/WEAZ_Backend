import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  InitializePaymentDto,
  PaymentInitResult,
  VerifyPaymentDto,
  PaymentVerifyResult,
} from './payment.types';

/**
 * Scaffolded payment service.
 * Gateway calls are stubbed with deterministic dummy responses.
 * When real integration is needed, replace the private gateway methods
 * (initPaystack, initFlutterwave, etc.) with actual SDK/API calls —
 * the public contract stays the same.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Initialize payment ──────────────────────────────────────────
  async initializePayment(dto: InitializePaymentDto, userId: string): Promise<PaymentInitResult> {
    const reference = `TH-${Date.now()}-${uuidv4().slice(0, 8)}`;

    // Mark orders with the selected payment method + reference (ownership-scoped)
    const updated = await this.prisma.order.updateMany({
      where: { id: { in: dto.orderIds }, buyerId: userId },
      data: {
        paymentMethod: dto.paymentMethod,
        paymentReference: reference,
        paymentGateway: dto.paymentMethod,
      },
    });

    if (updated.count === 0) {
      throw new BadRequestException('No eligible orders found');
    }

    switch (dto.paymentMethod) {
      case PaymentMethod.PAYSTACK:
        return this.initPaystack(reference, dto);

      case PaymentMethod.FLUTTERWAVE:
        return this.initFlutterwave(reference, dto);

      case PaymentMethod.BANK_TRANSFER:
        return this.initBankTransfer(reference, dto);

      case PaymentMethod.PAY_ON_DELIVERY:
        return this.initPayOnDelivery(reference, dto);

      default:
        throw new BadRequestException(`Unsupported payment method: ${dto.paymentMethod}`);
    }
  }

  // ── Verify payment ──────────────────────────────────────────────
  async verifyPayment(dto: VerifyPaymentDto, userId: string): Promise<PaymentVerifyResult> {
    const orders = await this.prisma.order.findMany({
      where: { paymentReference: dto.reference, buyerId: userId },
    });

    if (!orders.length) {
      throw new BadRequestException('No orders found for this reference');
    }

    // In scaffold mode, any verification succeeds
    const totalAmount = orders.reduce(
      (sum, o) => sum + Number(o.totalAmount) + Number(o.shippingCost),
      0,
    );

    const now = new Date();

    // Mark all orders as paid (ownership-scoped)
    await this.prisma.order.updateMany({
      where: { paymentReference: dto.reference, buyerId: userId },
      data: {
        paymentStatus: PaymentStatus.PAID,
        paidAt: now,
      },
    });

    this.logger.log(
      `Payment verified: ${dto.reference} — ${orders.length} order(s), total ${totalAmount}`,
    );

    return {
      success: true,
      reference: dto.reference,
      amount: totalAmount,
      currency: orders[0].currency,
      paidAt: now.toISOString(),
      channel: dto.gateway,
      gatewayResponse: 'Scaffold: Payment successful',
    };
  }

  // ── Handle webhook (Paystack / Flutterwave) ─────────────────────
  async handleWebhook(gateway: string, payload: Record<string, any>): Promise<void> {
    // SCAFFOLD: In production, validate webhook signature and process
    const reference = payload?.data?.reference ?? payload?.txRef;
    if (!reference) {
      this.logger.warn(`Webhook from ${gateway}: missing reference`);
      return;
    }

    this.logger.log(`Webhook received from ${gateway}: ${reference}`);
    // In production: verify with gateway, update order statuses
  }

  // ── Private: Gateway-specific initializers ──────────────────────

  /**
   * SCAFFOLD: Paystack integration.
   * Production: POST https://api.paystack.co/transaction/initialize
   */
  private async initPaystack(
    reference: string,
    dto: InitializePaymentDto,
  ): Promise<PaymentInitResult> {
    // Real implementation would call Paystack API here:
    // const response = await axios.post('https://api.paystack.co/transaction/initialize', {
    //   email: dto.email,
    //   amount: totalAmountInKobo,
    //   reference,
    //   callback_url: dto.callbackUrl,
    // }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    // return { reference, gateway: 'PAYSTACK', authorizationUrl: response.data.data.authorization_url };

    return {
      reference,
      gateway: 'PAYSTACK',
      authorizationUrl: `https://checkout.paystack.com/scaffold/${reference}`,
    };
  }

  /**
   * SCAFFOLD: Flutterwave integration.
   * Production: POST https://api.flutterwave.com/v3/payments
   */
  private async initFlutterwave(
    reference: string,
    dto: InitializePaymentDto,
  ): Promise<PaymentInitResult> {
    // Real implementation would call Flutterwave API here:
    // const response = await axios.post('https://api.flutterwave.com/v3/payments', {
    //   tx_ref: reference,
    //   amount: totalAmount,
    //   currency: 'NGN',
    //   redirect_url: dto.callbackUrl,
    //   customer: { email: dto.email },
    // }, { headers: { Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}` } });
    // return { reference, gateway: 'FLUTTERWAVE', authorizationUrl: response.data.data.link };

    return {
      reference,
      gateway: 'FLUTTERWAVE',
      authorizationUrl: `https://checkout.flutterwave.com/scaffold/${reference}`,
    };
  }

  /**
   * SCAFFOLD: Bank transfer (virtual account / direct).
   * Production: POST https://api.paystack.co/dedicated_account
   * or Flutterwave virtual account endpoint.
   */
  private async initBankTransfer(
    reference: string,
    _dto: InitializePaymentDto,
  ): Promise<PaymentInitResult> {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30min window

    return {
      reference,
      gateway: 'BANK_TRANSFER',
      bankAccount: {
        bankName: 'Wema Bank',
        accountNumber: '0123456789',
        accountName: 'Threadly Escrow',
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /**
   * Pay on Delivery — no gateway call needed.
   */
  private async initPayOnDelivery(
    reference: string,
    _dto: InitializePaymentDto,
  ): Promise<PaymentInitResult> {
    return {
      reference,
      gateway: 'PAY_ON_DELIVERY',
      directApproval: true,
    };
  }
}
