import 'reflect-metadata';
import {
  MarketSuggestionContext,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';
import {
  MARKET_SECTION_CODE_DEFAULTS,
  MARKET_SUGGESTION_BLOCK_CODE_DEFAULTS,
  MarketGovernanceConfigService,
} from './market-governance-config.service';

describe('MarketGovernanceConfigService', () => {
  const createPrisma = (overrides: Record<string, any> = {}) => ({
    marketSectionConfig: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    marketSuggestionBlockConfig: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  });

  it('returns code defaults when market section config table is empty', async () => {
    const prisma = createPrisma();
    const service = new MarketGovernanceConfigService(prisma as any);

    await expect(service.getSectionConfigsWithFallback()).resolves.toEqual({
      items: MARKET_SECTION_CODE_DEFAULTS,
      configReadStatus: 'code-defaults',
    });
  });

  it('falls back to section code defaults when config read fails', async () => {
    const prisma = createPrisma({
      marketSectionConfig: {
        findMany: jest.fn().mockRejectedValue(new Error('db unavailable')),
      },
    });
    const service = new MarketGovernanceConfigService(prisma as any);

    await expect(service.getSectionConfigsWithFallback()).resolves.toEqual({
      items: MARKET_SECTION_CODE_DEFAULTS,
      configReadStatus: 'fallback-code-defaults',
    });
  });

  it('merges persisted section rows with code defaults', async () => {
    const prisma = createPrisma({
      marketSectionConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            sectionKey: 'fresh-drops',
            title: 'Fresh Picks',
            subtitle: null,
            enabled: false,
            displayOrder: 99,
            previewItemLimit: 4,
            detailPageLimit: 12,
            minimumItems: 2,
            viewAllEnabled: false,
            fallbackMode: 'DB_OVERRIDE',
            metadata: { test: true },
          },
        ]),
      },
    });
    const service = new MarketGovernanceConfigService(prisma as any);

    const result = await service.getSectionConfigsWithFallback();

    expect(result.configReadStatus).toBe('db');
    expect(
      result.items.find((item) => item.sectionKey === 'fresh-drops'),
    ).toMatchObject({
      title: 'Fresh Picks',
      enabled: false,
      source: 'db',
    });
    expect(
      result.items.find((item) => item.sectionKey === 'hot-right-now'),
    ).toMatchObject({
      source: 'code-default',
    });
  });

  it('returns suggestion block defaults when config table is empty', async () => {
    const prisma = createPrisma();
    const service = new MarketGovernanceConfigService(prisma as any);

    await expect(
      service.getSuggestionBlockConfigsWithFallback(),
    ).resolves.toEqual({
      items: MARKET_SUGGESTION_BLOCK_CODE_DEFAULTS,
      configReadStatus: 'code-defaults',
    });
  });

  it('falls back to suggestion block code defaults when config read fails', async () => {
    const prisma = createPrisma({
      marketSuggestionBlockConfig: {
        findMany: jest.fn().mockRejectedValue(new Error('db unavailable')),
      },
    });
    const service = new MarketGovernanceConfigService(prisma as any);

    await expect(
      service.getSuggestionBlockConfigsWithFallback(),
    ).resolves.toEqual({
      items: MARKET_SUGGESTION_BLOCK_CODE_DEFAULTS,
      configReadStatus: 'fallback-code-defaults',
    });
  });

  it('maps persisted suggestion block configs without raw JSON internals', async () => {
    const prisma = createPrisma({
      marketSuggestionBlockConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            blockKey: 'brand-detail-best-from-brand',
            context: MarketSuggestionContext.BRAND_DETAIL,
            targetType: MarketSuggestionTargetType.BRAND,
            title: 'Best From This Brand',
            subtitle: 'Available now',
            enabled: true,
            displayOrder: 1,
            sourceType: 'PRODUCT',
            fallbackSourceType: 'PRODUCT',
            itemLimit: 6,
            metadata: { ownerManaged: true },
          },
        ]),
      },
    });
    const service = new MarketGovernanceConfigService(prisma as any);

    await expect(
      service.getSuggestionBlockConfigsWithFallback(),
    ).resolves.toEqual({
      items: [
        {
          blockKey: 'brand-detail-best-from-brand',
          context: MarketSuggestionContext.BRAND_DETAIL,
          targetType: MarketSuggestionTargetType.BRAND,
          title: 'Best From This Brand',
          subtitle: 'Available now',
          enabled: true,
          displayOrder: 1,
          sourceType: 'PRODUCT',
          fallbackSourceType: 'PRODUCT',
          itemLimit: 6,
          metadata: { ownerManaged: true },
          source: 'db',
        },
      ],
      configReadStatus: 'db',
    });
  });
});
