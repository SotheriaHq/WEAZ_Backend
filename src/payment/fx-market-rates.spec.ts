import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { FxMarketRates } from './fx-market-rates';

const today = new Date().toISOString().slice(0, 10);
const row = (quote: string, rate: number) => ({ date: today, base: 'USD', quote, rate });

describe('FxMarketRates provider table', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  const respond = (body: unknown) =>
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });

  it('skips non-ISO crypto rows instead of rejecting the whole table', async () => {
    // Frankfurter v2 started listing crypto assets with 4-letter codes (Nov 2026).
    respond([row('AAVE', 0.0083225), row('NGN', 1500), row('GHS', 15), row('ALGO', 11.2522)]);
    const { rate } = await new FxMarketRates('https://fx.test').pair('NGN', 'GHS');
    expect(rate.toNumber()).toBeCloseTo(0.01, 8);
  });

  it('never prices a skipped crypto code', async () => {
    respond([row('AAVE', 0.0083225), row('NGN', 1500)]);
    await expect(new FxMarketRates('https://fx.test').pair('NGN', 'AAVE')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still rejects the table when a row is structurally invalid', async () => {
    respond([row('NGN', 1500), row('GHS', -1)]);
    await expect(new FxMarketRates('https://fx.test').pair('NGN', 'GHS')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
