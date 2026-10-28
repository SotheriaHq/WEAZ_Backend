import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Observation = { rate: number; date: string };
type Table = { rates: Record<string, Observation>; fetchedAt: number };
const REFRESH_MS = 60 * 60 * 1000;
const DISPLAY_STALE_MS = 72 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30_000;

/** One bounded upstream table per process/hour, shared by concurrent requests. */
export class FxMarketRates {
  private table: Table | null = null;
  private pending: Promise<Table> | null = null;
  private retryAfter = 0;
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.FX_RATE_API_URL?.trim() || 'https://api.frankfurter.dev') {
    this.baseUrl = baseUrl;
  }

  async getTable(allowStale = false): Promise<Table & { isStale: boolean }> {
    const now = Date.now();
    if (this.table && now - this.table.fetchedAt < REFRESH_MS) return { ...this.table, isStale: false };
    if (now < this.retryAfter) return this.fallback(allowStale);
    if (!this.pending) {
      this.pending = this.fetchTable().then(table => {
        this.table = table;
        this.retryAfter = 0;
        return table;
      }).catch(error => {
        this.retryAfter = Date.now() + FAILURE_BACKOFF_MS;
        throw error;
      }).finally(() => { this.pending = null; });
    }
    try { return { ...await this.pending, isStale: false }; }
    catch { return this.fallback(allowStale); }
  }

  private fallback(allowStale: boolean): Table & { isStale: boolean } {
    if (allowStale && this.table && Date.now() - this.table.fetchedAt <= DISPLAY_STALE_MS) {
      return { ...this.table, isStale: true };
    }
    throw new ServiceUnavailableException('FX_RATES_TEMPORARILY_UNAVAILABLE');
  }

  async pair(from: string, to: string, allowStale = false) {
    const table = await this.getTable(allowStale);
    const source = table.rates[from];
    const destination = table.rates[to];
    if (!source || !destination) throw new BadRequestException('Unsupported currency code');
    const rate = new Prisma.Decimal(destination.rate).div(source.rate);
    if (!rate.isFinite() || !rate.greaterThan(0)) throw new ServiceUnavailableException('FX_RATE_INVALID');
    return { rate, date: source.date < destination.date ? source.date : destination.date, table };
  }

  private async fetchTable(): Promise<Table> {
    const base = new URL(this.baseUrl);
    // Production must use HTTPS; loopback HTTP supports repeatable HTTP fixtures.
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) {
      throw new ServiceUnavailableException('FX_PROVIDER_URL_INVALID');
    }
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/v2/rates`, base);
    // USD observations avoid inverting the provider's rounded NGN->USD rate.
    // The public contract still exposes NGN as the application's base currency.
    url.searchParams.set('base', 'USD');
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new ServiceUnavailableException('FX_PROVIDER_UNAVAILABLE');
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.length === 0 || body.length > 300) throw new ServiceUnavailableException('FX_PROVIDER_RESPONSE_INVALID');
    const rates: Record<string, Observation> = Object.create(null);
    const now = Date.now();
    for (const row of body) {
      if (!row || row.base !== 'USD' || !/^[A-Z]{3}$/.test(row.quote) || typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0 || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
        throw new ServiceUnavailableException('FX_PROVIDER_RESPONSE_INVALID');
      }
      const observedAt = Date.parse(`${row.date}T00:00:00Z`);
      if (!Number.isFinite(observedAt) || observedAt > now + 86400000 || now - observedAt > 7 * 86400000) continue;
      if (rates[row.quote]) throw new ServiceUnavailableException('FX_PROVIDER_DUPLICATE_CURRENCY');
      rates[row.quote] = { rate: row.rate, date: row.date };
    }
    if (!rates.NGN) throw new ServiceUnavailableException('FX_PROVIDER_NGN_RATE_MISSING');
    rates.USD = { rate: 1, date: rates.NGN.date };
    return { rates, fetchedAt: now };
  }
}
