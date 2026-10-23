import { CustomOrdersService } from './custom-orders.service';

describe('custom checkout bag source batching', () => {
  it('deduplicates sources and bounds source hydration to 500 per joined read', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = Object.assign(Object.create(CustomOrdersService.prototype), { prisma: { $queryRaw: query } });
    const sources = Array.from({ length: 501 }, (_, i) => ({ sourceType: 'PRODUCT', sourceId: String(i) }));
    await service.loadCheckoutBagSourceSnapshots([...sources, sources[0]]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0].values[0]).toHaveLength(500);
  });

  it('keeps missing-source bag lines without falling back to per-item reads', async () => {
    const resolve = jest.fn();
    const service = Object.assign(Object.create(CustomOrdersService.prototype), {
      resolveSourceSnapshot: resolve,
      normalizeCheckoutIntentRequestSnapshot: () => ({ chartLock: {}, measurementValues: {} }),
    });
    const now = new Date();
    const session = { id: 'session', submittedAt: now, updatedAt: now, checkoutIntent: {
      configurationId: 'config', expiresAt: new Date(+now + 1000), buyerPriceSummaryJson: {},
    } };
    const config = new Map([['config', { sourceType: 'PRODUCT', sourceId: 'gone', title: 'Saved title' }]]);
    const line = await service.mapCheckoutBagLine(session, config, new Map());
    expect(line.sourceTitle).toBe('Saved title');
    expect(line.sourcePrimaryMediaUrl).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
