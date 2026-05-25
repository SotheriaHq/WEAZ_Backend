import 'reflect-metadata';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import {
  MarketSuggestionContext,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';
import { MarketSuggestionController } from './market-suggestion.controller';

describe('MarketSuggestionController', () => {
  it('uses private no-store cache headers for suggestions', () => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      MarketSuggestionController.prototype.getSuggestions,
    );

    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-store',
    });
  });

  it('derives authenticated userId and passes anonymous session to service', async () => {
    const service = {
      getSuggestions: jest.fn().mockResolvedValue({ blocks: [] }),
    };
    const controller = new MarketSuggestionController(service as any);

    await controller.getSuggestions(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_1',
        anonymousSessionId: 'anon_1',
      },
      { user: { sub: 'user_1' } },
    );

    expect(service.getSuggestions).toHaveBeenCalledWith(
      {
        context: MarketSuggestionContext.PRODUCT_DETAIL,
        targetType: MarketSuggestionTargetType.PRODUCT,
        targetId: 'product_1',
        anonymousSessionId: 'anon_1',
      },
      {
        userId: 'user_1',
        anonymousSessionId: 'anon_1',
      },
    );
  });
});
