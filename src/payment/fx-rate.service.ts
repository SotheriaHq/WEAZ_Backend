import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ExchangeRateSnapshot,
  ExchangeRateSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

type GatewayRateResolution = {
  source: ExchangeRateSource;
  rate: number;
  rawPayload?: Record<string, unknown>;
} | null;

const DEFAULT_FX_QUOTE_SUPPORTED_CURRENCIES = ['NGN', 'USD', 'EUR', 'GBP'];
const DEFAULT_FX_QUOTE_MAX_AMOUNT = 10_000_000;

@Injectable()
export class FxRateService {
  private readonly logger = new Logger(FxRateService.name);
  private readonly baseCurrency = 'NGN';
  private readonly frankfurterBaseUrl =
    process.env.FX_RATE_API_URL?.trim() || 'https://api.frankfurter.app';

  constructor(private readonly prisma: PrismaService) {}

  getBaseCurrency() {
    return this.baseCurrency;
  }

  async quoteAndPersist(params: {
    from: string;
    to?: string;
    amount: number;
    actorId?: string | null;
  }): Promise<{
    snapshot: ExchangeRateSnapshot;
    convertedAmount: Prisma.Decimal;
  }> {
    const from = this.normalizeCurrency(params.from);
    const to = this.normalizeCurrency(params.to || this.baseCurrency);
    const amount = this.normalizeAmount(params.amount);

    const rateData =
      from === to
        ? {
            source: ExchangeRateSource.PARITY,
            rate: 1,
            rawPayload: { provider: 'internal-parity' },
          }
        : await this.fetchFrankfurterRate(from, to);

    const snapshot = await this.prisma.exchangeRateSnapshot.create({
      data: {
        id: uuidv4(),
        provider:
          rateData.source === ExchangeRateSource.PARITY
            ? 'INTERNAL_PARITY'
            : 'FRANKFURTER',
        baseCurrency: from,
        quoteCurrency: to,
        rate: new Prisma.Decimal(rateData.rate.toFixed(8)),
        capturedAt: new Date(),
        source: rateData.source,
        rawPayload: (rateData.rawPayload ?? null) as Prisma.InputJsonValue,
        createdById: params.actorId ?? null,
      },
    });

    return {
      snapshot,
      convertedAmount: this.convertAmount(amount, rateData.rate),
    };
  }

  async getQuotePreview(params: {
    from: string;
    to?: string;
    amount: number;
  }): Promise<{
    provider: string;
    source: ExchangeRateSource;
    from: string;
    to: string;
    rate: number;
    amount: number;
    convertedAmount: number;
  }> {
    const supportedCurrencies = this.getQuotePreviewSupportedCurrencies();
    const from = this.normalizeCurrency(params.from, { supportedCurrencies });
    const to = this.normalizeCurrency(params.to || this.baseCurrency, {
      supportedCurrencies,
    });
    const amount = this.normalizeAmount(params.amount, {
      max: this.getQuotePreviewMaxAmount(),
    });

    if (from === to) {
      return {
        provider: 'INTERNAL_PARITY',
        source: ExchangeRateSource.PARITY,
        from,
        to,
        rate: 1,
        amount,
        convertedAmount: Number(amount.toFixed(2)),
      };
    }

    const rateData = await this.fetchFrankfurterRate(from, to);
    return {
      provider: 'FRANKFURTER',
      source: rateData.source,
      from,
      to,
      rate: rateData.rate,
      amount,
      convertedAmount: this.convertAmount(amount, rateData.rate).toNumber(),
    };
  }

  async resolveSettlement(params: {
    attempt: {
      currency: string;
      amount: Prisma.Decimal;
      exchangeRateSnapshotId?: string | null;
      exchangeRateSnapshot?: ExchangeRateSnapshot | null;
    };
    gateway: string;
    payload?: Record<string, any>;
  }): Promise<{
    settlementCurrency: string;
    settlementAmount: Prisma.Decimal;
    exchangeRateSnapshotId: string | null;
  }> {
    const originalCurrency = this.normalizeCurrency(params.attempt.currency);
    const originalAmount = Number(params.attempt.amount);

    if (originalCurrency === this.baseCurrency) {
      return {
        settlementCurrency: this.baseCurrency,
        settlementAmount: new Prisma.Decimal(originalAmount.toFixed(2)),
        exchangeRateSnapshotId: params.attempt.exchangeRateSnapshotId ?? null,
      };
    }

    const gatewayRate = this.resolveGatewayRate(params.gateway, params.payload);
    if (gatewayRate) {
      const snapshot = await this.prisma.exchangeRateSnapshot.create({
        data: {
          id: uuidv4(),
          provider: params.gateway.toUpperCase(),
          baseCurrency: originalCurrency,
          quoteCurrency: this.baseCurrency,
          rate: new Prisma.Decimal(gatewayRate.rate.toFixed(8)),
          capturedAt: new Date(),
          source: gatewayRate.source,
          rawPayload: (gatewayRate.rawPayload ?? null) as Prisma.InputJsonValue,
        },
      });

      return {
        settlementCurrency: this.baseCurrency,
        settlementAmount: this.convertAmount(originalAmount, gatewayRate.rate),
        exchangeRateSnapshotId: snapshot.id,
      };
    }

    if (params.attempt.exchangeRateSnapshotId) {
      const snapshot =
        params.attempt.exchangeRateSnapshot ??
        (await this.prisma.exchangeRateSnapshot.findUnique({
          where: { id: params.attempt.exchangeRateSnapshotId },
        }));

      if (snapshot) {
        return {
          settlementCurrency: this.baseCurrency,
          settlementAmount: this.convertAmount(
            originalAmount,
            Number(snapshot.rate),
          ),
          exchangeRateSnapshotId: snapshot.id,
        };
      }
    }

    const fallback = await this.quoteAndPersist({
      from: originalCurrency,
      to: this.baseCurrency,
      amount: originalAmount,
    });

    return {
      settlementCurrency: this.baseCurrency,
      settlementAmount: fallback.convertedAmount,
      exchangeRateSnapshotId: fallback.snapshot.id,
    };
  }

  private async fetchFrankfurterRate(from: string, to: string): Promise<{
    source: ExchangeRateSource;
    rate: number;
    rawPayload: Record<string, unknown>;
  }> {
    const url = new URL('/latest', this.frankfurterBaseUrl);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      this.logger.error(
        `FX quote request failed: ${response.status} ${response.statusText}`,
      );
      throw new BadRequestException('Unable to fetch FX conversion rate');
    }

    const data = (await response.json()) as {
      amount?: number;
      base?: string;
      date?: string;
      rates?: Record<string, number>;
    };
    const rate = Number(data?.rates?.[to]);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('FX provider did not return a valid rate');
    }

    return {
      source: ExchangeRateSource.FRANKFURTER,
      rate,
      rawPayload: data as Record<string, unknown>,
    };
  }

  private resolveGatewayRate(
    gateway: string,
    payload?: Record<string, any>,
  ): GatewayRateResolution {
    const normalizedGateway = String(gateway || '').trim().toUpperCase();
    const rateCandidate = this.extractNumericRate(payload);
    if (!rateCandidate || rateCandidate <= 0) return null;

    if (normalizedGateway === 'PAYSTACK') {
      return {
        source: ExchangeRateSource.PAYSTACK,
        rate: rateCandidate,
        rawPayload: payload,
      };
    }

    if (normalizedGateway === 'FLUTTERWAVE') {
      return {
        source: ExchangeRateSource.FLUTTERWAVE,
        rate: rateCandidate,
        rawPayload: payload,
      };
    }

    return null;
  }

  private extractNumericRate(payload?: Record<string, any>): number | null {
    if (!payload || typeof payload !== 'object') return null;

    const candidates = [
      payload?.data?.exchange_rate,
      payload?.data?.rate,
      payload?.data?.meta?.exchange_rate,
      payload?.exchange_rate,
      payload?.rate,
      payload?.settlement_rate,
    ];

    for (const candidate of candidates) {
      const rate = Number(candidate);
      if (Number.isFinite(rate) && rate > 0) {
        return rate;
      }
    }

    return null;
  }

  private getQuotePreviewSupportedCurrencies(): Set<string> {
    const configured = String(process.env.FX_QUOTE_SUPPORTED_CURRENCIES ?? '')
      .split(',')
      .map((currency) => currency.trim().toUpperCase())
      .filter((currency) => /^[A-Z]{3}$/.test(currency));

    return new Set(
      configured.length > 0
        ? configured
        : DEFAULT_FX_QUOTE_SUPPORTED_CURRENCIES,
    );
  }

  private getQuotePreviewMaxAmount(): number {
    const configured = Number(process.env.FX_QUOTE_MAX_AMOUNT ?? '');
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_FX_QUOTE_MAX_AMOUNT;
  }

  private normalizeCurrency(
    currency: string,
    options?: { supportedCurrencies?: Set<string> },
  ): string {
    const normalized = String(currency || '').trim().toUpperCase();
    if (!normalized || normalized.length !== 3) {
      throw new BadRequestException('Invalid currency code');
    }
    if (
      options?.supportedCurrencies &&
      !options.supportedCurrencies.has(normalized)
    ) {
      throw new BadRequestException('Unsupported currency code');
    }
    return normalized;
  }

  private normalizeAmount(amount: number, options?: { max?: number }): number {
    const normalized = Number(amount);
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }
    if (options?.max && normalized > options.max) {
      throw new BadRequestException('Amount exceeds FX quote limit');
    }
    return normalized;
  }

  private convertAmount(amount: number, rate: number): Prisma.Decimal {
    return new Prisma.Decimal((amount * rate).toFixed(2));
  }
}
