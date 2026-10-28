import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ExchangeRateSnapshot,
  ExchangeRateSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { FxMarketRates } from './fx-market-rates';
import { COUNTRY_CURRENCIES } from './country-currencies';
import { CHARGE_CURRENCIES, SETTLEMENT_CURRENCY } from './currency-policy';

const DEFAULT_FX_QUOTE_SUPPORTED_CURRENCIES = [...new Set(Object.values(COUNTRY_CURRENCIES).flatMap(country => country.currencies))];
const DEFAULT_FX_QUOTE_MAX_AMOUNT = 10_000_000;

@Injectable()
export class FxRateService {
  private readonly baseCurrency = SETTLEMENT_CURRENCY;
  private readonly marketRates = new FxMarketRates();

  constructor(private readonly prisma: PrismaService) {}

  getBaseCurrency() {
    return this.baseCurrency;
  }

  async getDisplayRates(params: { country?: string; currency?: string }) {
    const supported = this.getQuotePreviewSupportedCurrencies();
    const override = params.currency ? this.normalizeCurrency(params.currency, { supportedCurrencies: supported }) : null;
    const countryInput = String(params.country ?? '').trim();
    const countryCode = Object.keys(COUNTRY_CURRENCIES).find(code =>
      code === countryInput.toUpperCase() || COUNTRY_CURRENCIES[code].name.toLowerCase() === countryInput.toLowerCase(),
    ) ?? null;
    const table = await this.marketRates.getTable(true);
    const localCurrencies = countryCode ? COUNTRY_CURRENCIES[countryCode].currencies.filter(code => supported.has(code) && table.rates[code]) : [];
    // A country can have several legal currencies. Do not invent a preference.
    const displayCurrency = override ?? (localCurrencies.length === 1 ? localCurrencies[0] : this.baseCurrency);
    if (!table.rates[displayCurrency]) throw new BadRequestException('Unsupported currency code');
    const base = new Prisma.Decimal(table.rates.NGN.rate);
    const rates = Object.fromEntries(Object.entries(table.rates).filter(([code]) => supported.has(code)).map(([code, observation]) => [code, {
      rate: new Prisma.Decimal(observation.rate).div(base).toNumber(),
      asOf: observation.date < table.rates.NGN.date ? observation.date : table.rates.NGN.date,
    }]));
    rates.NGN = { rate: 1, asOf: table.rates.NGN.date };
    return {
      // Shoppers are charged in this currency whatever they choose to read.
      baseCurrency: this.baseCurrency, chargeCurrency: CHARGE_CURRENCIES[0], displayCurrency, countryCode,
      selectionSource: override ? 'EXPLICIT' : localCurrencies.length === 1 ? 'COUNTRY' : 'BASE_FALLBACK',
      countryCurrencies: localCurrencies, needsCurrencyChoice: !override && localCurrencies.length > 1,
      isEstimate: true, isStale: table.isStale, provider: 'FRANKFURTER_V2',
      fetchedAt: new Date(table.fetchedAt).toISOString(),
      expiresAt: new Date(table.fetchedAt + 3600000).toISOString(), rates,
    };
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

    const lockedRate = new Prisma.Decimal(rateData.rate).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    if (!lockedRate.greaterThan(0)) throw new BadRequestException('FX rate is below supported precision');
    const snapshot = await this.prisma.exchangeRateSnapshot.create({
      data: {
        id: uuidv4(),
        provider:
          rateData.source === ExchangeRateSource.PARITY
            ? 'INTERNAL_PARITY'
            : 'FRANKFURTER',
        baseCurrency: from,
        quoteCurrency: to,
        rate: lockedRate,
        capturedAt: new Date(),
        source: rateData.source,
        rawPayload: (rateData.rawPayload ?? null) as Prisma.InputJsonValue,
        createdById: params.actorId ?? null,
      },
    });

    return {
      snapshot,
      convertedAmount: this.convertAmount(amount, lockedRate),
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
    const originalAmount = params.attempt.amount;

    if (originalCurrency === this.baseCurrency) {
      return {
        settlementCurrency: this.baseCurrency,
        settlementAmount: new Prisma.Decimal(originalAmount.toFixed(2)),
        exchangeRateSnapshotId: params.attempt.exchangeRateSnapshotId ?? null,
      };
    }

    // Initialization records the payment's conversion before capture. Reuse
    // it during verification; current market rates cannot repair old money.
    if (params.attempt.exchangeRateSnapshotId) {
      const snapshot = params.attempt.exchangeRateSnapshot ?? await this.prisma.exchangeRateSnapshot.findUnique({ where: { id: params.attempt.exchangeRateSnapshotId } });
      if (!snapshot || snapshot.id !== params.attempt.exchangeRateSnapshotId || snapshot.baseCurrency !== originalCurrency || snapshot.quoteCurrency !== this.baseCurrency || !snapshot.rate.isFinite() || !snapshot.rate.greaterThan(0)) {
        throw new BadRequestException('FX_ORIGINAL_PAYMENT_SNAPSHOT_INVALID');
      }
      return {
        settlementCurrency: this.baseCurrency,
        settlementAmount: this.convertAmount(originalAmount, snapshot.rate),
        exchangeRateSnapshotId: snapshot.id,
      };
    }

    throw new BadRequestException('FX_ORIGINAL_PAYMENT_SNAPSHOT_REQUIRED');
  }

  private async fetchFrankfurterRate(
    from: string,
    to: string,
  ): Promise<{
    source: ExchangeRateSource;
    rate: number;
    rawPayload: Record<string, unknown>;
  }> {
    const quote = await this.marketRates.pair(from, to);
    return {
      source: ExchangeRateSource.FRANKFURTER,
      rate: quote.rate.toNumber(),
      rawPayload: { provider: 'FRANKFURTER_V2', referenceBase: 'USD', from, to, fromObservation: quote.table.rates[from], toObservation: quote.table.rates[to], date: quote.date },
    };
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
    const normalized = String(currency || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized)) {
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

  private convertAmount(amount: number | Prisma.Decimal, rate: number | Prisma.Decimal): Prisma.Decimal {
    return new Prisma.Decimal(amount).mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
}
