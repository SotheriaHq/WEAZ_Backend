import { ConflictException, Injectable } from '@nestjs/common';
import { PersonalizationResetType } from '@prisma/client';
import { marketActivationState } from 'src/market/intelligence/market-intelligence.contracts';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  ResetFeedPreferencesDto,
  UpdateMarketPreferencesDto,
} from './dto/feed-preferences.dto';

/** Reset types that cover the Market taste profile. */
const MARKET_PROFILE_RESETS: ReadonlySet<PersonalizationResetType> = new Set([
  PersonalizationResetType.MARKET,
  PersonalizationResetType.ALL,
]);

const PREFERENCE_SELECT = {
  marketPersonalization: true,
  marketRegionalOptIn: true,
  marketAdultConfirmedAt: true,
  state: true,
} as const;

interface StoredMarketPreferences {
  marketPersonalization: boolean;
  marketRegionalOptIn: boolean;
  marketAdultConfirmedAt: Date | null;
  state: string | null;
}

export interface MarketPreferencesView {
  personalization: boolean;
  regionalOptIn: boolean;
  declaredState: string | null;
  /** The shopper confirmed they are 18+ (L5). Without it nobody is personalised. */
  adultConfirmed: boolean;
  /** True only when the personal flag is on and retention allows profiles. */
  personalizationAvailable: boolean;
  regionalAvailable: boolean;
}

@Injectable()
export class FeedPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async resetFeedPreferences(userId: string, dto: ResetFeedPreferencesDto) {
    const resetAt = new Date();
    const clearsProfile = MARKET_PROFILE_RESETS.has(dto.resetType);
    // The marker and the profile delete commit together, so a reset never
    // leaves the old taste profile behind. Raw events expire through the
    // retention sweep; the profile builder ignores events before the reset.
    const [reset] = await this.prisma.$transaction([
      this.prisma.personalizationReset.create({
        data: {
          userId,
          resetAt,
          resetType: dto.resetType,
          reason: dto.reason?.trim() || null,
        },
      }),
      ...(clearsProfile
        ? [this.prisma.userMarketAffinity.deleteMany({ where: { userId } })]
        : []),
    ]);

    return {
      ...reset,
      resetPolicy: {
        suppressionsCleared: false,
        rawSignalsDeleted: false,
        seenHistoryDeleted: false,
        globalAggregatesCleared: false,
        derivedProfileDeleted: clearsProfile,
      },
    };
  }

  async getMarketPreferences(userId: string): Promise<MarketPreferencesView> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: PREFERENCE_SELECT,
    });
    return this.view(profile);
  }

  async updateMarketPreferences(
    userId: string,
    dto: UpdateMarketPreferencesDto,
  ): Promise<MarketPreferencesView> {
    const activation = marketActivationState();
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { state: true, marketAdultConfirmedAt: true },
    });
    if (!profile) {
      throw new ConflictException({
        code: 'PROFILE_REQUIRED',
        message: 'Finish your profile before changing Market preferences.',
      });
    }
    // Opting in to regional picks is accepted only once the feature and its
    // policy text are live, and only with a declared state (D-06). Opting out
    // and turning personalisation off are always accepted.
    if (dto.regionalOptIn === true) {
      if (!activation.regional) {
        throw new ConflictException({
          code: 'REGIONAL_UNAVAILABLE',
          message: 'Popular in your state is not available yet.',
        });
      }
      if (!profile.state?.trim()) {
        throw new ConflictException({
          code: 'STATE_REQUIRED',
          message: 'Add your state to your profile to see picks from it.',
        });
      }
    }

    const data: {
      marketPersonalization?: boolean;
      marketRegionalOptIn?: boolean;
      marketAdultConfirmedAt?: Date;
    } = {};
    if (dto.personalization !== undefined)
      data.marketPersonalization = dto.personalization;
    if (dto.regionalOptIn !== undefined)
      data.marketRegionalOptIn = dto.regionalOptIn;
    // One-way: a confirmation is recorded once and never overwritten.
    if (dto.confirmAdult === true && !profile.marketAdultConfirmedAt)
      data.marketAdultConfirmedAt = new Date();

    const [updated] = await this.prisma.$transaction([
      this.prisma.userProfile.update({
        where: { userId },
        data,
        select: PREFERENCE_SELECT,
      }),
      // "Don't personalise my Market" deletes the taste profile at once.
      ...(dto.personalization === false
        ? [this.prisma.userMarketAffinity.deleteMany({ where: { userId } })]
        : []),
    ]);
    return this.view(updated, activation);
  }

  private view(
    profile: StoredMarketPreferences | null,
    activation = marketActivationState(),
  ): MarketPreferencesView {
    return {
      personalization: profile?.marketPersonalization ?? true,
      regionalOptIn: profile?.marketRegionalOptIn ?? false,
      declaredState: profile?.state?.trim() || null,
      adultConfirmed: Boolean(profile?.marketAdultConfirmedAt),
      personalizationAvailable: activation.personal,
      regionalAvailable: activation.regional,
    };
  }
}
