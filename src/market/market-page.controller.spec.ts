import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { HEADERS_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import {
  MarketPageController,
  parseMarketPageRequest,
} from './market-page.controller';
import { MarketFlagsService } from './market-flags.service';
import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';

describe('Market page HTTP boundary', () => {
  const user = '00000000-0000-0000-0000-000000000001';
  it.each([
    'surface=PRODUCT',
    'limit=0',
    'limit=9',
    'limit=1&limit=2',
    'surface=HOME&surface=HOME',
    'anonymousSessionId=short',
    'viewer=other',
    'sort=price_asc',
    'cursor=spoof',
  ])('rejects unsupported or forged page controls: %s', (query) => {
    expect(() => parseMarketPageRequest(new URLSearchParams(query))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
  it('keeps user ownership separate from validated anonymous identity and preserves literal array values', () => {
    const request = parseMarketPageRequest(
      new URLSearchParams(
        'limit=2&anonymousSessionId=anonymous_session_1234&size[]=42%2C5',
      ),
      user,
    );
    expect(request.viewer).toEqual({ userId: user });
    expect(request.limit).toBe(2);
    expect(request.filters.sizes).toEqual(['42,5']);
    expect(
      parseMarketPageRequest(
        new URLSearchParams('anonymousSessionId=anonymous_session_1234'),
      ).viewer,
    ).toEqual({ anonymousSessionId: 'anonymous_session_1234' });
  });
  it('gates before any parsing or composition', async () => {
    const page = jest.fn(),
      flags = { isEnabled: jest.fn().mockReturnValue(false) };
    const controller = new MarketPageController(
      { page } as unknown as MarketPipelineDeliveryService,
      flags as unknown as MarketFlagsService,
    );
    await expect(
      controller.page({ originalUrl: 'http://[' } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(page).not.toHaveBeenCalled();
  });
  it('passes client abort to actual composition and always removes its listener', async () => {
    const request = Object.assign(new EventEmitter(), {
      originalUrl: '/market/page?limit=1',
      user: { sub: user },
    });
    const page = jest.fn(async (input) => {
      request.emit('aborted');
      expect(input.signal.aborted).toBe(true);
      return { sections: [] };
    });
    const controller = new MarketPageController(
      { page } as unknown as MarketPipelineDeliveryService,
      { isEnabled: () => true } as unknown as MarketFlagsService,
    );
    await controller.page(request as never);
    expect(page.mock.calls[0][0].viewer).toEqual({ userId: user });
    expect(request.listenerCount('aborted')).toBe(0);
  });
  it.each([false, true])(
    'handles response closure after a fully received GET (completed=%s) and cleans listeners',
    async (writableEnded) => {
      const response = Object.assign(new EventEmitter(), { writableEnded });
      const request = Object.assign(new EventEmitter(), {
        originalUrl: '/market/page',
        res: response,
      });
      const page = jest.fn(async (input) => {
        response.emit('close');
        expect(input.signal.aborted).toBe(!writableEnded);
        return { sections: [] };
      });
      const controller = new MarketPageController(
        { page } as unknown as MarketPipelineDeliveryService,
        { isEnabled: () => true } as unknown as MarketFlagsService,
      );
      await controller.page(request as never);
      expect(response.listenerCount('close')).toBe(0);
      expect(request.listenerCount('aborted')).toBe(0);
    },
  );
  it('keeps public optional authentication, no-store and explicit request throttling', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MarketPageController),
    ).toContain(OptionalJwtAuthGuard);
    expect(
      Reflect.getMetadata(
        HEADERS_METADATA,
        MarketPageController.prototype.page,
      ),
    ).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
    expect(
      Reflect.getMetadata(
        `${THROTTLER_LIMIT}default`,
        MarketPageController.prototype.page,
      ),
    ).toBe(60);
  });
});
