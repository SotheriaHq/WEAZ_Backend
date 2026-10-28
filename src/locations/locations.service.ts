import { Injectable, Logger } from '@nestjs/common';
import { COUNTRY_CURRENCIES } from 'src/payment/country-currencies';

/** CLDR regions that are not countries a person lives in. */
const NOT_COUNTRIES = new Set(['EU', 'AC', 'DG', 'EA', 'IC', 'TA']);
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_LISTS = 500;
const TIMEOUT_MS = 5000;
const MAX_ITEMS = 2000;
const NAME = /^[\p{L}\p{M} .,'’()&-]{2,80}$/u;

export type CountryOption = { iso2: string; name: string };

/**
 * Country, state and city lists for address and profile forms.
 *
 * Browsers and the app used to fetch these from third-party services, which
 * showed every visitor's IP address to them. They now ask WIEZ: countries come
 * from the bundled CLDR list, and states and cities are fetched here, cached,
 * and never stored. An empty list means "type it in"; it is never an error.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);
  private readonly upstream =
    process.env.LOCATION_DATA_API_URL?.trim() ||
    'https://countriesnow.space/api/v0.1/countries';
  private readonly countries: CountryOption[] = Object.entries(
    COUNTRY_CURRENCIES,
  )
    .filter(([iso2]) => !NOT_COUNTRIES.has(iso2))
    .map(([iso2, { name }]) => ({ iso2, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  private readonly cache = new Map<
    string,
    { value: string[]; expiresAt: number }
  >();
  private readonly pending = new Map<string, Promise<string[]>>();

  listCountries(): CountryOption[] {
    return this.countries;
  }

  async listStates(country: string): Promise<string[]> {
    const name = this.countryName(country);
    if (!name) return [];
    return this.cached(`states:${name}`, () =>
      this.fetchList('/states/q', { country: name }, (data) =>
        Array.isArray((data as { states?: unknown })?.states)
          ? (data as { states: Array<{ name?: unknown }> }).states.map(
              (state) => state?.name,
            )
          : [],
      ),
    );
  }

  async listCities(country: string, state: string): Promise<string[]> {
    const name = this.countryName(country);
    const stateName = String(state ?? '').trim();
    if (!name || !NAME.test(stateName)) return [];
    return this.cached(`cities:${name}:${stateName.toLowerCase()}`, () =>
      this.fetchList(
        '/state/cities/q',
        { country: name, state: stateName },
        (data) => (Array.isArray(data) ? data : []),
      ),
    );
  }

  /** A known code or name resolves to its CLDR name; other plain names pass through. */
  private countryName(input: string): string | null {
    const value = String(input ?? '').trim();
    if (!value) return null;
    const byCode = COUNTRY_CURRENCIES[value.toUpperCase()];
    if (byCode && !NOT_COUNTRIES.has(value.toUpperCase())) return byCode.name;
    return NAME.test(value) ? value : null;
  }

  private async cached(
    key: string,
    load: () => Promise<string[] | null>,
  ): Promise<string[]> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const promise = load()
      .then((value) => {
        this.remember(
          key,
          value ?? [],
          value ? SUCCESS_TTL_MS : FAILURE_TTL_MS,
        );
        return value ?? [];
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private remember(key: string, value: string[], ttl: number) {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
    while (this.cache.size > MAX_CACHED_LISTS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Null means the source failed: cached briefly, answered as an empty list. */
  private async fetchList(
    path: string,
    params: Record<string, string>,
    pick: (data: unknown) => unknown[],
  ): Promise<string[] | null> {
    try {
      const url = new URL(`${this.upstream.replace(/\/$/, '')}${path}`);
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        error?: unknown;
        data?: unknown;
      };
      if (body?.error) return [];
      const names = pick(body?.data)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 100);
      return [...new Set(names)].slice(0, MAX_ITEMS);
    } catch (error) {
      this.logger.warn(
        `Location list ${path} unavailable: ${(error as Error)?.name ?? 'Error'}`,
      );
      return null;
    }
  }
}
