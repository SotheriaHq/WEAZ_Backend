import { BadRequestException } from '@nestjs/common';
import { FxRateService } from './fx-rate.service';

describe('FxRateService quote preview safety', () => {
  let originalSupported: string | undefined;
  let originalMaxAmount: string | undefined;

  beforeEach(() => {
    originalSupported = process.env.FX_QUOTE_SUPPORTED_CURRENCIES;
    originalMaxAmount = process.env.FX_QUOTE_MAX_AMOUNT;
    delete process.env.FX_QUOTE_SUPPORTED_CURRENCIES;
    delete process.env.FX_QUOTE_MAX_AMOUNT;
  });

  afterEach(() => {
    if (originalSupported === undefined) {
      delete process.env.FX_QUOTE_SUPPORTED_CURRENCIES;
    } else {
      process.env.FX_QUOTE_SUPPORTED_CURRENCIES = originalSupported;
    }

    if (originalMaxAmount === undefined) {
      delete process.env.FX_QUOTE_MAX_AMOUNT;
    } else {
      process.env.FX_QUOTE_MAX_AMOUNT = originalMaxAmount;
    }
    jest.restoreAllMocks();
  });

  it('serves same-currency preview quotes without calling the external provider', async () => {
    const prisma = { exchangeRateSnapshot: { create: jest.fn() } };
    const service = new FxRateService(prisma as any);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      service.getQuotePreview({ from: 'NGN', to: 'NGN', amount: 25000 }),
    ).resolves.toMatchObject({
      provider: 'INTERNAL_PARITY',
      from: 'NGN',
      to: 'NGN',
      amount: 25000,
      convertedAmount: 25000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unsupported public FX quote currencies before provider lookup', async () => {
    const service = new FxRateService({} as any);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      service.getQuotePreview({ from: 'AAA', to: 'NGN', amount: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized public FX quote amounts before provider lookup', async () => {
    process.env.FX_QUOTE_MAX_AMOUNT = '1000';
    const service = new FxRateService({} as any);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      service.getQuotePreview({ from: 'USD', to: 'NGN', amount: 1001 }),
    ).rejects.toThrow('Amount exceeds FX quote limit');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
