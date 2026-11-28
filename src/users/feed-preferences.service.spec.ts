import { ConflictException } from '@nestjs/common';
import { PersonalizationResetType } from '@prisma/client';
import { FeedPreferencesService } from './feed-preferences.service';

const ENV_KEYS = [
  'MARKET_PERSONAL_V1',
  'MARKET_REGIONAL_V1',
  'MARKET_RAW_SIGNAL_RETENTION_HOURS',
] as const;

function createPrisma(profile: Record<string, unknown> | null = null) {
  const prisma = {
    personalizationReset: {
      create: jest.fn().mockResolvedValue({ id: 'reset_1' }),
    },
    userMarketAffinity: { deleteMany: jest.fn().mockResolvedValue({}) },
    userFeedSignal: { deleteMany: jest.fn() },
    userSeenItem: { deleteMany: jest.fn() },
    userContentSuppression: { deleteMany: jest.fn() },
    marketSignalAggregateDaily: { deleteMany: jest.fn() },
    userProfile: {
      findUnique: jest.fn().mockResolvedValue(profile),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          marketPersonalization: true,
          marketRegionalOptIn: false,
          marketAdultConfirmedAt: null,
          state: null,
          ...profile,
          ...data,
        }),
      ),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return prisma;
}

describe('FeedPreferencesService', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('reset', () => {
    it('deletes the Market taste profile with the reset marker, and keeps raw history', async () => {
      const prisma = createPrisma();
      const service = new FeedPreferencesService(prisma as any);

      const result = await service.resetFeedPreferences('user_1', {
        resetType: PersonalizationResetType.MARKET,
        reason: 'fresh start',
      });

      expect(prisma.personalizationReset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user_1',
          resetType: PersonalizationResetType.MARKET,
          reason: 'fresh start',
        }),
      });
      expect(prisma.userMarketAffinity.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.resetPolicy).toEqual({
        suppressionsCleared: false,
        rawSignalsDeleted: false,
        seenHistoryDeleted: false,
        globalAggregatesCleared: false,
        derivedProfileDeleted: true,
      });
      expect(prisma.userFeedSignal.deleteMany).not.toHaveBeenCalled();
      expect(prisma.userSeenItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.userContentSuppression.deleteMany).not.toHaveBeenCalled();
      expect(
        prisma.marketSignalAggregateDaily.deleteMany,
      ).not.toHaveBeenCalled();
    });

    it('leaves the Market profile alone for a feed-only reset', async () => {
      const prisma = createPrisma();
      const service = new FeedPreferencesService(prisma as any);

      const result = await service.resetFeedPreferences('user_1', {
        resetType: PersonalizationResetType.FEED,
      });

      expect(prisma.userMarketAffinity.deleteMany).not.toHaveBeenCalled();
      expect(result.resetPolicy.derivedProfileDeleted).toBe(false);
    });
  });

  describe('market preferences', () => {
    it('reports both features unavailable while their flags are off', async () => {
      const service = new FeedPreferencesService(
        createPrisma({
          marketPersonalization: true,
          marketRegionalOptIn: false,
          marketAdultConfirmedAt: null,
          state: ' Lagos ',
        }) as any,
      );

      await expect(service.getMarketPreferences('user_1')).resolves.toEqual({
        personalization: true,
        regionalOptIn: false,
        declaredState: 'Lagos',
        adultConfirmed: false,
        personalizationAvailable: false,
        regionalAvailable: false,
      });
    });

    it('needs the R2 retention window as well as the flag before personalisation is available', async () => {
      process.env.MARKET_PERSONAL_V1 = 'true';
      const service = new FeedPreferencesService(createPrisma() as any);
      expect(
        (await service.getMarketPreferences('user_1')).personalizationAvailable,
      ).toBe(false);

      process.env.MARKET_RAW_SIGNAL_RETENTION_HOURS = '720';
      expect(
        (await service.getMarketPreferences('user_1')).personalizationAvailable,
      ).toBe(true);
    });

    it('deletes the taste profile when personalisation is turned off', async () => {
      const prisma = createPrisma({
        state: null,
        marketAdultConfirmedAt: null,
      });
      const service = new FeedPreferencesService(prisma as any);

      const view = await service.updateMarketPreferences('user_1', {
        personalization: false,
      });

      expect(view.personalization).toBe(false);
      expect(prisma.userMarketAffinity.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user_1' },
      });
    });

    it('refuses a regional opt-in while the regional flag is off', async () => {
      const prisma = createPrisma({
        state: 'Lagos',
        marketAdultConfirmedAt: null,
      });
      const service = new FeedPreferencesService(prisma as any);

      await expect(
        service.updateMarketPreferences('user_1', { regionalOptIn: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.userProfile.update).not.toHaveBeenCalled();
    });

    it('needs a declared state for a regional opt-in, and always accepts an opt-out', async () => {
      process.env.MARKET_REGIONAL_V1 = 'true';
      const prisma = createPrisma({
        state: '  ',
        marketAdultConfirmedAt: null,
      });
      const service = new FeedPreferencesService(prisma as any);

      await expect(
        service.updateMarketPreferences('user_1', { regionalOptIn: true }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'STATE_REQUIRED' }),
      });

      delete process.env.MARKET_REGIONAL_V1;
      const view = await service.updateMarketPreferences('user_1', {
        regionalOptIn: false,
      });
      expect(view.regionalOptIn).toBe(false);
    });

    it('records the 18+ confirmation once and never moves it', async () => {
      const prisma = createPrisma({
        state: null,
        marketAdultConfirmedAt: null,
      });
      const service = new FeedPreferencesService(prisma as any);

      const view = await service.updateMarketPreferences('user_1', {
        confirmAdult: true,
      });
      expect(view.adultConfirmed).toBe(true);
      expect(prisma.userProfile.update.mock.calls[0][0].data).toEqual({
        marketAdultConfirmedAt: expect.any(Date),
      });

      const confirmedAt = new Date('2026-11-01T00:00:00.000Z');
      const again = createPrisma({
        state: null,
        marketAdultConfirmedAt: confirmedAt,
      });
      await new FeedPreferencesService(again as any).updateMarketPreferences(
        'user_1',
        { confirmAdult: true },
      );
      expect(again.userProfile.update.mock.calls[0][0].data).toEqual({});
    });

    it('asks for a profile before saving choices', async () => {
      const service = new FeedPreferencesService(createPrisma(null) as any);
      await expect(
        service.updateMarketPreferences('user_1', { personalization: false }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PROFILE_REQUIRED' }),
      });
    });
  });
});
