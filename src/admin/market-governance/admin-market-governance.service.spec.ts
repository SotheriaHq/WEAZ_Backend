import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminAuditAction } from '@prisma/client';
import { AdminAuditService } from '../services/admin-audit.service';
import { AdminMarketGovernanceService } from './admin-market-governance.service';
import {
  MARKET_SECTION_CODE_DEFAULTS,
  MarketGovernanceConfigService,
} from 'src/market/market-governance-config.service';
import { MarketRankingConfigService } from 'src/market/market-ranking-config.service';
import { MarketSuggestionTargetType } from 'src/market/dto/market-suggestion.dto';

describe('AdminMarketGovernanceService', () => {
  const actorId = 'admin_1';
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'jest' },
  } as any;

  const sectionRow = (overrides: Record<string, any> = {}) => ({
    id: 'section_config_1',
    sectionKey: 'fresh-drops',
    title: 'Fresh Drops',
    subtitle: 'New products from open WIEZ stores.',
    enabled: true,
    displayOrder: 10,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    createdById: actorId,
    updatedById: actorId,
    createdAt: new Date('2026-05-26T00:00:00.000Z'),
    updatedAt: new Date('2026-05-26T00:00:00.000Z'),
    ...overrides,
  });

  const createHarness = (overrides: Record<string, any> = {}) => {
    const tx = {
      marketSectionConfig: {
        upsert: jest.fn().mockResolvedValue(sectionRow()),
        create: jest
          .fn()
          .mockResolvedValue(sectionRow({ sectionKey: 'runway-edit' })),
      },
      marketSuggestionBlockConfig: {
        create: jest.fn().mockResolvedValue({
          id: 'block_1',
          blockKey: 'product-detail-more-like-this',
        }),
        update: jest.fn(),
      },
    };
    const prisma = {
      marketSectionConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      marketSuggestionBlockConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adminAuditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn((callback) => callback(tx)),
      ...overrides.prisma,
    };
    const audit = {
      logInTransaction: jest.fn().mockResolvedValue(undefined),
      ...overrides.audit,
    };
    const config = new MarketGovernanceConfigService(prisma as any);
    const rankingConfig = new MarketRankingConfigService();
    const service = new AdminMarketGovernanceService(
      prisma as any,
      audit as unknown as AdminAuditService,
      config,
      rankingConfig,
    );

    return { audit, prisma, service, tx };
  };

  it('rejects unknown section keys with a controlled error', async () => {
    const { service } = createHarness();

    await expect(
      service.patchSection(
        'unsupported-section',
        { enabled: true },
        actorId,
        req,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents disabling every primary market section', async () => {
    const existingRows = MARKET_SECTION_CODE_DEFAULTS.map((config) =>
      sectionRow({
        sectionKey: config.sectionKey,
        title: config.title,
        subtitle: config.subtitle,
        enabled: config.sectionKey === 'fresh-drops',
        displayOrder: config.displayOrder,
        previewItemLimit: config.previewItemLimit,
        detailPageLimit: config.detailPageLimit,
        minimumItems: config.minimumItems,
        viewAllEnabled: config.viewAllEnabled,
        fallbackMode: config.fallbackMode,
      }),
    );
    const { service } = createHarness({
      prisma: {
        marketSectionConfig: {
          findUnique: jest.fn().mockResolvedValue(existingRows[0]),
          findMany: jest.fn().mockResolvedValue(existingRows),
        },
      },
    });

    await expect(
      service.patchSection('fresh-drops', { enabled: false }, actorId, req),
    ).rejects.toThrow('At least one active market section must remain enabled');
  });

  it('creates custom market sections without behavior-specific wiring', async () => {
    const { audit, prisma, service, tx } = createHarness();

    await service.createSection(
      {
        sectionKey: 'runway-edit',
        title: 'Runway Edit',
        sourceType: 'DESIGN',
      },
      actorId,
      req,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.marketSectionConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sectionKey: 'runway-edit',
          sourceType: 'DESIGN',
          fallbackMode: 'SOURCE_TEMPLATE',
          viewAllEnabled: true,
        }),
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
        targetId: 'runway-edit',
        metadata: expect.objectContaining({ mode: 'create' }),
      }),
      req,
    );
  });

  it('updates existing custom market sections with partial patch data', async () => {
    const customRow = sectionRow({
      sectionKey: 'runway-edit',
      title: 'Runway Edit',
      subtitle: 'Original subtitle',
      status: 'ACTIVE',
      sourceType: 'DESIGN',
      rankingProfileKey: 'deterministic-v1',
      viewAllLabel: 'View all runway',
      fallbackSectionKey: 'fresh-drops',
      guestEnabled: true,
      requiresAuth: false,
      newBrandReservedRatio: 0,
    });
    const { service, tx } = createHarness({
      prisma: {
        marketSectionConfig: {
          findUnique: jest.fn().mockResolvedValue(customRow),
          findMany: jest.fn().mockResolvedValue([customRow]),
        },
      },
    });
    tx.marketSectionConfig.upsert.mockResolvedValue({
      ...customRow,
      subtitle: 'Updated subtitle',
    });

    await expect(
      service.patchSection(
        'runway-edit',
        { subtitle: 'Updated subtitle' },
        actorId,
        req,
      ),
    ).resolves.toEqual(expect.objectContaining({ sectionKey: 'runway-edit' }));

    expect(tx.marketSectionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sectionKey: 'runway-edit' },
        create: expect.objectContaining({
          sectionKey: 'runway-edit',
          title: 'Runway Edit',
          sourceType: 'DESIGN',
        }),
        update: expect.objectContaining({
          subtitle: 'Updated subtitle',
        }),
      }),
    );
  });

  it('refuses a classic patch once a section is published', async () => {
    const { prisma, service } = createHarness();
    prisma.marketSectionConfig.findUnique.mockResolvedValue({
      sectionKey: 'fresh-drops',
      publishedVersionId: 'version_1',
    });

    await expect(
      service.patchSection('fresh-drops', { title: 'Drift' }, actorId, req),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes section config and audit in one transaction', async () => {
    const { audit, prisma, service, tx } = createHarness();

    await service.patchSection(
      'fresh-drops',
      { title: 'Fresh Picks' },
      actorId,
      req,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.marketSectionConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sectionKey: 'fresh-drops' },
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorUserId: actorId,
        action: AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
        targetType: 'MarketSectionConfig',
        targetId: 'fresh-drops',
      }),
      req,
    );
  });

  it('fails mutation when audit logging fails', async () => {
    const { service } = createHarness({
      audit: {
        logInTransaction: jest
          .fn()
          .mockRejectedValue(new Error('audit failed')),
      },
    });

    await expect(
      service.patchSection(
        'fresh-drops',
        { title: 'Fresh Picks' },
        actorId,
        req,
      ),
    ).rejects.toThrow('audit failed');
  });

  it('rejects unsupported suggestion contexts', async () => {
    const { service } = createHarness();

    await expect(
      service.createSuggestionBlock(
        {
          blockKey: 'bad-block',
          context: 'UNSUPPORTED',
          targetType: MarketSuggestionTargetType.PRODUCT,
          title: 'Bad Block',
          sourceType: 'PRODUCT',
        },
        actorId,
        req,
      ),
    ).rejects.toThrow('Unsupported suggestion context');
  });

  it('returns release status with production readiness disabled', async () => {
    const { service } = createHarness();

    const status = await service.getReleaseStatus();

    expect(status).toEqual(
      expect.objectContaining({
        rankingEnabled: false,
        rankingDefaultDisabled: true,
        deterministicFallbackEnabled: true,
        productionReady: false,
        phase14Required: true,
      }),
    );
    // Ranking profile and formula tables are no longer read (the harness has
    // no mocks for them, so a read would throw).
    expect(status).not.toHaveProperty('activeRankingProfile');
    expect(status).not.toHaveProperty('activeFormulaVersion');
    expect(status).not.toHaveProperty('lastRollback');
  });

  it('lists market governance audit logs without exposing unrelated actions', async () => {
    const { prisma, service } = createHarness();

    await service.listAuditLogs({ limit: 20 });

    expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: {
            in: expect.arrayContaining([
              AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
              AdminAuditAction.ADMIN_MARKET_RANKING_ROLLBACK,
            ]),
          },
        },
        take: 21,
      }),
    );
  });
});
