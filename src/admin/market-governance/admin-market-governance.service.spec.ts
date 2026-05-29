import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
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
    subtitle: 'New products from open Threadly stores.',
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
      },
      marketRankingProfile: {
        create: jest.fn().mockResolvedValue({
          id: 'profile_1',
          profileKey: 'phase13-shadow',
        }),
        update: jest.fn(),
      },
      marketRankingFormulaVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({
          id: 'formula_1',
          versionKey: 'aggregate-v1',
          status: 'DRAFT',
        }),
        update: jest.fn(),
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
      marketRankingProfile: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      marketRankingFormulaVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
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

  it('rejects unsupported section keys with a controlled error', async () => {
    const { service } = createHarness();

    await expect(
      service.patchSection(
        'unsupported-section',
        { enabled: true },
        actorId,
        req,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
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
    ).rejects.toThrow('At least one market section must remain enabled');
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

  it('rejects ranking profiles that disable deterministic fallback', async () => {
    const { service } = createHarness();

    await expect(
      service.createRankingProfile(
        {
          profileKey: 'phase13-shadow',
          name: 'Phase 13 Shadow',
          fallbackDeterministic: false,
        },
        actorId,
        req,
      ),
    ).rejects.toThrow('Deterministic fallback cannot be disabled');
  });

  it('rejects ranking profiles that attempt rollout before Phase 14', async () => {
    const { service } = createHarness();

    await expect(
      service.createRankingProfile(
        {
          profileKey: 'phase13-shadow',
          name: 'Phase 13 Shadow',
          rolloutPercent: 1,
        },
        actorId,
        req,
      ),
    ).rejects.toThrow('Ranking rollout percent must remain 0 before Phase 14');
  });

  it('rejects unsupported formula weights', async () => {
    const { service } = createHarness();

    await expect(
      service.createRankingFormula(
        {
          versionKey: 'aggregate-v1',
          name: 'Aggregate V1',
          weights: { rawClicks: 1 },
        },
        actorId,
        req,
      ),
    ).rejects.toThrow('Unsupported formula weight');
  });

  it('activates one formula while preserving prior history', async () => {
    const { audit, service, tx } = createHarness();
    tx.marketRankingFormulaVersion.findMany.mockResolvedValue([
      { id: 'old_formula', versionKey: 'aggregate-old' },
    ]);
    tx.marketRankingFormulaVersion.create.mockResolvedValue({
      id: 'new_formula',
      versionKey: 'aggregate-v2',
      status: 'ACTIVE',
    });

    await service.createRankingFormula(
      {
        versionKey: 'aggregate-v2',
        name: 'Aggregate V2',
        status: 'ACTIVE',
        weights: { freshness: 0.4, interaction: 0.4 },
      },
      actorId,
      req,
    );

    expect(tx.marketRankingFormulaVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'DEPRECATED' }),
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: AdminAuditAction.ADMIN_MARKET_RANKING_FORMULA_ACTIVATE,
      }),
      req,
    );
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

    await expect(service.getReleaseStatus()).resolves.toEqual(
      expect.objectContaining({
        rankingEnabled: false,
        rankingDefaultDisabled: true,
        deterministicFallbackEnabled: true,
        productionReady: false,
        phase14Required: true,
      }),
    );
  });

  it('returns controlled rollback failure when no prior formula exists', async () => {
    const { service } = createHarness({
      prisma: {
        marketRankingFormulaVersion: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'active', versionKey: 'active-v1' })
            .mockResolvedValueOnce(null),
        },
      },
    });

    await expect(
      service.rollbackRanking({ reason: 'test' }, actorId, req),
    ).rejects.toThrow('Ranking rollback requires an active formula');
  });

  it('rehearses rollback without mutating config', async () => {
    const { prisma, service } = createHarness({
      prisma: {
        marketRankingFormulaVersion: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 'active', versionKey: 'active-v1' })
            .mockResolvedValueOnce({
              id: 'prior',
              versionKey: 'prior-v1',
              status: 'DEPRECATED',
            }),
        },
      },
    });

    await expect(service.rehearseRollback()).resolves.toEqual(
      expect.objectContaining({
        rehearsalOnly: true,
        mutatesConfig: false,
        deterministicFallbackAvailable: true,
        canRollbackFormula: true,
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
