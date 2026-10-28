import { Prisma } from '@prisma/client';
import { RefundProviderClient, RefundCapture } from './refund-provider.client';

const capture = (overrides: Partial<RefundCapture> = {}): RefundCapture => ({
  reference: 'TH-UC-1',
  provider: 'PAYSTACK',
  providerMode: 'test',
  providerTransactionId: '501',
  amount: new Prisma.Decimal('40.00'),
  currency: 'USD',
  settlementAmount: new Prisma.Decimal('54448.00'),
  settlementCurrency: 'NGN',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('RefundProviderClient', () => {
  const originalKey = process.env.PAYSTACK_SECRET_KEY;
  let fetchMock: jest.Mock;
  const client = new RefundProviderClient({ PAYSTACK: 'https://paystack.test' });

  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_synthetic';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    process.env.PAYSTACK_SECRET_KEY = originalKey;
  });

  it('treats what was charged, not the NGN settlement, as the refundable amount', () => {
    expect(client.chargedAmount(capture())).toEqual({ currency: 'USD', amount: new Prisma.Decimal('40.00') });
  });

  it('verifies the original capture in the charged currency', async () => {
    fetchMock.mockResolvedValueOnce(json({
      status: true,
      data: { id: 501, reference: 'TH-UC-1', status: 'success', amount: 4000, currency: 'USD' },
    }));
    await expect(client.verifyCapture(capture())).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(json({
      status: true,
      data: { id: 501, reference: 'TH-UC-1', status: 'success', amount: 5444800, currency: 'NGN' },
    }));
    await expect(client.verifyCapture(capture())).rejects.toMatchObject({ code: 'REFUND_ORIGINAL_CAPTURE_VERIFICATION_MISMATCH' });
  });

  it('submits the refund in the charged currency and its minor units', async () => {
    fetchMock.mockResolvedValueOnce(json({
      status: true,
      data: { id: 9, status: 'pending', amount: 4000, currency: 'USD', merchant_note: 'n', transaction: { id: 501, reference: 'TH-UC-1' } },
    }));
    await client.submit(capture(), { amount: new Prisma.Decimal('40.00'), currency: 'USD' }, 'n');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ transaction: 'TH-UC-1', amount: 4000, currency: 'USD', merchant_note: 'n' });
  });

  it('looks refunds up with documented list parameters only, paging until it finds the note', async () => {
    const other = (id: number) => ({ id, status: 'pending', amount: 100, currency: 'NGN', merchant_note: 'other', transaction: id });
    fetchMock
      .mockResolvedValueOnce(json({ status: true, data: Array.from({ length: 100 }, (_, index) => other(1000 + index)) }))
      .mockResolvedValueOnce(json({ status: true, data: [{ id: 9, status: 'pending', amount: 4000, currency: 'USD', merchant_note: 'WIEZ standard refund r1', transaction: 501 }] }));

    const since = new Date('2026-10-27T12:00:00Z');
    const found = await client.findByNote(capture(), 'WIEZ standard refund r1', since);

    expect(found).toHaveLength(1);
    expect(found?.[0]).toMatchObject({ id: '9', transactionId: '501' });
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url as string));
    expect(urls.map((url) => [...url.searchParams.keys()].sort())).toEqual([
      ['from', 'page', 'perPage'],
      ['from', 'page', 'perPage'],
    ]);
    expect(urls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(Date.parse(urls[0].searchParams.get('from')!)).toBeLessThan(since.getTime());
  });

  it('reports unknown, never "none", when a page fails or there are too many pages', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: false }, 503));
    await expect(client.findByNote(capture(), 'm')).resolves.toBeNull();

    fetchMock.mockImplementation(async () => json({ status: true, data: Array.from({ length: 100 }, (_, id) => ({ id, merchant_note: 'x' })) }));
    await expect(client.findByNote(capture(), 'm')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1 + 10);
  });
});
