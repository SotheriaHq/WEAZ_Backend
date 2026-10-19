import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

export type SubscriptionProviderTransaction = {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  id?: number | string;
  paid_at?: string;
  paused?: boolean;
  authorization_url?: string;
  access_code?: string;
  customer?: { email?: string };
  authorization?: {
    authorization_code?: string;
    reusable?: boolean;
    [key: string]: unknown;
  };
};

export type SubscriptionProviderRefund = {
  id: number | string;
  status: string;
  amount?: number;
  currency?: string;
  transaction?: number | { id?: number | string; reference?: string };
};

@Injectable()
export class SubscriptionPaystackService {
  private async request<T>(
    route: string,
    body?: Record<string, unknown>,
    allowMissing = false,
  ): Promise<T | null> {
    if ((process.env.PAYMENTS_MODE ?? 'live').trim().toLowerCase() !== 'live') throw new ServiceUnavailableException('Subscription provider requests are disabled in simulated payment mode. No charge has been initiated.');
    const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
    if (!secret)
      throw new ServiceUnavailableException(
        'Subscription billing is temporarily unavailable. No payment has been initiated.',
      );
    let response: Response;
    try {
      response = await fetch(`https://api.paystack.co${route}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BadGatewayException(
        'Payment provider response is delayed. Check billing status before trying again.',
      );
    }
    let result: { status?: boolean; data?: T; message?: string };
    try {
      result = await response.json();
    } catch {
      throw new BadGatewayException(
        'Payment provider response could not be confirmed.',
      );
    }
    if (
      allowMissing &&
      (response.status === 404 ||
        (response.status === 400 &&
          /transaction.*not found|invalid transaction reference/i.test(
            result.message ?? '',
          )))
    )
      return null;
    if (!response.ok || result.status !== true || !result.data) {
      throw new BadGatewayException(
        'Subscription payment could not be confirmed. Check billing status or contact billing support.',
      );
    }
    return result.data;
  }

  initialize(
    reference: string,
    amountKobo: number,
    email: string,
    callbackUrl?: string,
  ) {
    return this.request<{
      reference: string;
      authorization_url: string;
      access_code: string;
    }>('/transaction/initialize', {
      reference,
      amount: amountKobo,
      email,
      currency: 'NGN',
      channels: ['card'],
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      metadata: {
        source: 'wiez-brand-subscription',
        subscriptionReference: reference,
      },
    });
  }

  verify(reference: string) {
    return this.request<SubscriptionProviderTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      undefined,
      true,
    );
  }

  charge(
    reference: string,
    amountKobo: number,
    authorizationCode: string,
    email: string,
  ) {
    return this.request<SubscriptionProviderTransaction>(
      '/transaction/charge_authorization',
      {
        reference,
        amount: amountKobo,
        email,
        currency: 'NGN',
        authorization_code: authorizationCode,
        metadata: {
          source: 'wiez-brand-subscription',
          subscriptionReference: reference,
        },
      },
    );
  }

  refund(reference: string, amountKobo: number) {
    return this.request<SubscriptionProviderRefund>('/refund', {
      transaction: reference,
      amount: amountKobo,
      currency: 'NGN',
      merchant_note:
        'WIEZ subscription duplicate or unapplied capture compensation',
    });
  }

  verifyRefund(refundId: string) {
    return this.request<SubscriptionProviderRefund>(
      `/refund/${encodeURIComponent(refundId)}`,
    );
  }
}
