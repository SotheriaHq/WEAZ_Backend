import 'reflect-metadata';
import {
  HEADERS_METADATA,
  GUARDS_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC_KEY } from '../../auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from '../../auth/guard/optional-jwt-auth.guard';
import { MarketFlagsService } from '../market-flags.service';
import { MarketCatalogService } from './market-catalog.service';
import { MarketCatalogController } from './market-catalog.controller';
import { MarketPipelineService } from '../pipeline/market-pipeline.service';

type Request = Parameters<MarketCatalogController['page']>[0];
const id = '00000000-0000-0000-0000-000000000001';
const request = (url: string, user?: Request['user']) =>
  ({ originalUrl: url, user }) as Request;
function fixture(enabled = true) {
  const page = jest.fn().mockResolvedValue({ items: [] }),
    facets = jest.fn().mockResolvedValue({});
  const isEnabled = jest.fn().mockReturnValue(enabled);
  return {
    page,
    facets,
    isEnabled,
    controller: new MarketCatalogController(
      { getPage: page, facets } as unknown as MarketCatalogService,
      { isEnabled } as unknown as MarketFlagsService,
    ),
  };
}

describe('public catalogue rollout boundary', () => {
  function sectionFixture() {
    const scope = { key: 'fresh-drops' };
    const getScope = jest.fn().mockResolvedValue({
      kind: 'catalogue',
      scope,
      fixedFilters: { onSale: true },
    });
    const facets = jest.fn().mockResolvedValue({ colors: [] });
    const controller = new MarketCatalogController(
      { facets } as unknown as MarketCatalogService,
      {
        isEnabled: (surface) => surface === 'SEE_ALL',
      } as unknown as MarketFlagsService,
      { getScope } as unknown as MarketPipelineService,
    );
    return { controller, getScope, facets, scope };
  }
  it('uses server-resolved section scope for See All facets with an independent rollout flag', async () => {
    const { controller, getScope, facets, scope } = sectionFixture();
    await controller.facets(
      request(
        '/market/facets?surface=SEE_ALL&sectionKey=fresh-drops&color=red&anonymousSessionId=anonymous_session_123',
        { id },
      ),
    );
    expect(getScope).toHaveBeenCalledWith({
      key: 'fresh-drops',
      viewer: { userId: id },
    });
    const [query, viewer, trusted] = facets.mock.calls[0];
    expect([...query]).toEqual([['color', 'red']]);
    expect(viewer).toEqual({ userId: id });
    expect(trusted).toEqual({ scope, fixedFilters: { onSale: true } });
  });
  it.each([
    'sectionKey=fresh-drops&sectionKey=almost-gone',
    'sectionKey=../../private',
    'sectionKey=fresh-drops&anonymousSessionId=x',
  ])(
    'rejects malformed See All controls before resolving a scope: %s',
    async (query) => {
      const { controller, getScope, facets } = sectionFixture();
      await expect(
        controller.facets(request(`/market/facets?surface=SEE_ALL&${query}`)),
      ).rejects.toMatchObject({ status: 400 });
      expect(getScope).not.toHaveBeenCalled();
      expect(facets).not.toHaveBeenCalled();
    },
  );
  it('does not return catalogue-wide counts for a non-product section', async () => {
    const { controller, getScope, facets } = sectionFixture();
    getScope.mockResolvedValueOnce({ kind: 'legacy' });
    await expect(
      controller.facets(
        request('/market/facets?surface=SEE_ALL&sectionKey=shop-the-look'),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(facets).not.toHaveBeenCalled();
  });
  it('keeps routes unavailable with default-off rollout configuration', () => {
    const catalog = { getPage: jest.fn(), facets: jest.fn() };
    const flags = new MarketFlagsService();
    jest
      .spyOn(flags, 'isEnabled')
      .mockImplementation((surface) =>
        new MarketFlagsService().isEnabled(surface, {}),
      );
    const controller = new MarketCatalogController(
      catalog as unknown as MarketCatalogService,
      flags,
    );
    expect(() => controller.page(request('/market/catalog'))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => controller.facets(request('/market/facets'))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(catalog.getPage).not.toHaveBeenCalled();
    expect(catalog.facets).not.toHaveBeenCalled();
  });
  it('does rollout gating before parsing hostile requests or calling the service', () => {
    const { controller, page, facets, isEnabled } = fixture(false);
    expect(() => controller.page(request('http://['))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => controller.facets(request('http://['))).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(isEnabled).toHaveBeenCalledWith('CATALOG');
    expect(page).not.toHaveBeenCalled();
    expect(facets).not.toHaveBeenCalled();
  });
  it('preserves the complete query and uses authenticated principal rather than query-supplied identity', async () => {
    const { controller, page } = fixture();
    await controller.page(
      request('/market/catalog?size%5B%5D=42%2C5&viewer=spoof', { id }),
    );
    const [query, viewer] = page.mock.calls[0];
    expect(query).toBeInstanceOf(URLSearchParams);
    expect(query.getAll('size[]')).toEqual(['42,5']);
    expect(query.get('viewer')).toBe('spoof');
    expect(viewer).toEqual({ userId: id });
  });
  it('supports sub-only JWT context and isolates guest requests', async () => {
    const { controller, page, facets } = fixture();
    await controller.page(request('/market/catalog', { sub: id }));
    await controller.facets(request('/market/facets?color=red'));
    expect(page.mock.calls[0][1]).toEqual({ userId: id });
    expect(facets.mock.calls[0][1]).toEqual({});
    expect(facets.mock.calls[0][0].get('color')).toBe('red');
  });

  it('carries a validated anonymous suppression identity without treating it as a filter', async () => {
    const { controller, page, facets } = fixture();
    await controller.page(
      request(
        '/market/catalog?anonymousSessionId=anonymous_session_123&color=red',
      ),
    );
    await controller.facets(
      request(
        '/market/facets?anonymousSessionId=anonymous_session_123&color=red',
      ),
    );
    for (const call of [page.mock.calls[0], facets.mock.calls[0]]) {
      expect(call[1]).toEqual({ anonymousSessionId: 'anonymous_session_123' });
      expect(call[0].has('anonymousSessionId')).toBe(false);
      expect(call[0].get('color')).toBe('red');
    }
  });

  it.each([
    'anonymousSessionId=x',
    'anonymousSessionId=anonymous_session_123&anonymousSessionId=anonymous_session_456',
  ])(
    'rejects malformed identity controls before calling catalogue readers: %s',
    (query) => {
      const { controller, page, facets } = fixture();
      expect(() =>
        controller.page(request(`/market/catalog?${query}`)),
      ).toThrow(expect.objectContaining({ status: 400 }));
      expect(() =>
        controller.facets(request(`/market/facets?${query}`)),
      ).toThrow(expect.objectContaining({ status: 400 }));
      expect(page).not.toHaveBeenCalled();
      expect(facets).not.toHaveBeenCalled();
    },
  );
  it('keeps optional JWT public access and private no-store responses', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MarketCatalogController)).toBe(
      'market',
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MarketCatalogController)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MarketCatalogController),
    ).toContain(OptionalJwtAuthGuard);
    for (const handler of [
      MarketCatalogController.prototype.page,
      MarketCatalogController.prototype.facets,
    ]) {
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toContainEqual({
        name: 'Cache-Control',
        value: 'private, no-store',
      });
    }
  });
  it('applies explicit endpoint throttles to catalogue pages and more expensive facets', () => {
    for (const [handler, limit] of [
      [MarketCatalogController.prototype.page, 60],
      [MarketCatalogController.prototype.facets, 30],
    ] as const) {
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(
        limit,
      );
      expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
        60000,
      );
    }
  });
});
