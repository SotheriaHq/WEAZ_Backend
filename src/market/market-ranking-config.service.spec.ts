import { MarketRankingConfigService } from './market-ranking-config.service';

describe('MarketRankingConfigService', () => {
  const service = new MarketRankingConfigService();

  it('defaults ranking to disabled with deterministic fallback enabled', () => {
    expect(service.getConfig({})).toEqual({
      enabled: false,
      shadowMode: true,
      sectionKeys: [],
      maxPersonalizedSections: 1,
      fallbackDeterministic: true,
      explorationPercent: 10,
      brandMaxShare: 35,
      aggregateTimeoutMs: 150,
    });
  });

  it('parses explicit ranking flags safely', () => {
    expect(
      service.getConfig({
        MARKET_RANKING_ENABLED: 'true',
        MARKET_RANKING_SHADOW_MODE: 'false',
        MARKET_RANKING_FALLBACK_DETERMINISTIC: 'true',
        MARKET_RANKING_MAX_PERSONALIZED_SECTIONS: '2',
        MARKET_RANKING_SECTION_KEYS: 'Fresh-Drops, hot-right-now ,fresh-drops',
        MARKET_RANKING_EXPLORATION_PERCENT: '12',
        MARKET_RANKING_BRAND_MAX_SHARE: '40',
        MARKET_RANKING_AGGREGATE_TIMEOUT_MS: '200',
      }),
    ).toEqual({
      enabled: true,
      shadowMode: false,
      fallbackDeterministic: true,
      maxPersonalizedSections: 2,
      sectionKeys: ['fresh-drops', 'hot-right-now'],
      explorationPercent: 12,
      brandMaxShare: 40,
      aggregateTimeoutMs: 200,
    });
  });

  it('falls back or clamps invalid values to safe bounds', () => {
    const config = service.getConfig({
      MARKET_RANKING_ENABLED: 'maybe',
      MARKET_RANKING_SHADOW_MODE: 'maybe',
      MARKET_RANKING_FALLBACK_DETERMINISTIC: 'maybe',
      MARKET_RANKING_MAX_PERSONALIZED_SECTIONS: '99',
      MARKET_RANKING_SECTION_KEYS:
        'fresh-drops, INVALID KEY, ,latest-collections, bad/key',
      MARKET_RANKING_EXPLORATION_PERCENT: '-5',
      MARKET_RANKING_BRAND_MAX_SHARE: '100',
      MARKET_RANKING_AGGREGATE_TIMEOUT_MS: '99999',
    });

    expect(config).toEqual({
      enabled: false,
      shadowMode: true,
      fallbackDeterministic: true,
      maxPersonalizedSections: 3,
      sectionKeys: ['fresh-drops', 'latest-collections'],
      explorationPercent: 0,
      brandMaxShare: 50,
      aggregateTimeoutMs: 500,
    });
  });

  it('bounds parsed section keys to twenty entries', () => {
    const keys = Array.from({ length: 25 }, (_, index) => `section-${index}`);

    expect(
      service.getConfig({
        MARKET_RANKING_SECTION_KEYS: keys.join(','),
      }).sectionKeys,
    ).toHaveLength(20);
  });
});
