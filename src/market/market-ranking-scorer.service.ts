import { Injectable } from '@nestjs/common';
import { MarketSignalTargetType } from '@prisma/client';
import {
  MarketSectionItemDto,
  MarketSectionKey,
} from './dto/market-section.dto';
import { MarketRankingConfig } from './market-ranking-config.service';
import { MarketRankingAggregateStats } from './market-ranking-aggregate-reader.service';

export type MarketRankingScorerInput = {
  sectionKey: MarketSectionKey;
  items: MarketSectionItemDto[];
  aggregates: Map<string, MarketRankingAggregateStats>;
  config: MarketRankingConfig;
};

export type MarketRankingScorerResult = {
  items: MarketSectionItemDto[];
  scoredCount: number;
};

type ScoredMarketItem = {
  item: MarketSectionItemDto;
  score: number;
  deterministicIndex: number;
};

@Injectable()
export class MarketRankingScorerService {
  rankItems(input: MarketRankingScorerInput): MarketRankingScorerResult {
    if (input.items.length <= 1) {
      return { items: input.items, scoredCount: input.items.length };
    }

    const scored = input.items.map((item, deterministicIndex) => ({
      item,
      deterministicIndex,
      score: this.scoreItem(input.sectionKey, item, deterministicIndex, input),
    }));

    scored.sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (Math.abs(scoreDelta) > 0.000001) return scoreDelta;
      const fallbackDelta = left.deterministicIndex - right.deterministicIndex;
      if (fallbackDelta !== 0) return fallbackDelta;
      return left.item.sourceId.localeCompare(right.item.sourceId);
    });

    return {
      items: this.applyBrandDiversity(scored, input.config).map(
        ({ item }) => item,
      ),
      scoredCount: scored.length,
    };
  }

  aggregateKeyForItem(item: MarketSectionItemDto) {
    return `${item.entityType as MarketSignalTargetType}:${item.sourceId}`;
  }

  targetTypeForItem(item: MarketSectionItemDto): MarketSignalTargetType {
    return item.entityType as MarketSignalTargetType;
  }

  private scoreItem(
    sectionKey: MarketSectionKey,
    item: MarketSectionItemDto,
    deterministicIndex: number,
    input: MarketRankingScorerInput,
  ) {
    const aggregate = input.aggregates.get(this.aggregateKeyForItem(item));
    const freshness = this.freshnessScore(item.createdAt);
    const interaction = this.interactionScore(aggregate);
    const commerce = this.commerceScore(aggregate);
    const section = this.sectionRelevanceScore(
      sectionKey,
      item,
      freshness,
      interaction,
    );
    const exploration = this.explorationScore(
      deterministicIndex,
      input.items.length,
      input.config.explorationPercent,
    );
    const deterministic =
      (input.items.length - deterministicIndex) / input.items.length;

    return (
      section * 0.34 +
      freshness * 0.2 +
      interaction * 0.24 +
      commerce * 0.14 +
      exploration * 0.04 +
      deterministic * 0.04
    );
  }

  private freshnessScore(createdAt: string | null) {
    if (!createdAt) return 0.25;
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) return 0.25;
    const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
    return this.clamp(1 / (1 + ageDays * 0.18), 0, 1);
  }

  private interactionScore(aggregate?: MarketRankingAggregateStats) {
    if (!aggregate) return 0;
    const positive =
      Math.log1p(aggregate.itemImpressions) * 0.12 +
      Math.log1p(aggregate.itemOpens) * 0.26 +
      Math.log1p(aggregate.productOpens) * 0.32 +
      Math.log1p(aggregate.clicks) * 0.16 +
      Math.log1p(aggregate.viewAllClicks) * 0.08;
    const negative = Math.log1p(aggregate.suppressions) * 0.35;
    return this.clamp((positive - negative) / 3, 0, 1);
  }

  private commerceScore(aggregate?: MarketRankingAggregateStats) {
    if (!aggregate) return 0;
    return this.clamp(
      (Math.log1p(aggregate.productOpens) * 0.55 +
        Math.log1p(aggregate.itemOpens) * 0.3 +
        Math.log1p(aggregate.clicks) * 0.15) /
        3,
      0,
      1,
    );
  }

  private sectionRelevanceScore(
    sectionKey: MarketSectionKey,
    item: MarketSectionItemDto,
    freshness: number,
    interaction: number,
  ) {
    switch (sectionKey) {
      case 'fresh-drops':
        return freshness;
      case 'hot-right-now':
      case 'loved-near-you':
      case 'still-thinking-about-these':
        return interaction;
      case 'shop-the-look':
        return item.entityType === 'COLLECTION' ? freshness : 0.25;
      case 'new-designers-to-watch':
        return item.entityType === 'BRAND' ? freshness : 0.25;
      case 'shop-by-style':
        return item.entityType === 'CATEGORY' ? 0.8 : 0.35;
      case 'almost-gone':
        return item.availability?.totalStock
          ? Math.max(0.2, 1 - item.availability.totalStock / 10)
          : 0.25;
      case 'picked-for-you':
      case 'more-from-brands-you-like':
      case 'style-picks-of-the-week':
        return Math.max(freshness, interaction * 0.75);
    }
  }

  private explorationScore(
    deterministicIndex: number,
    itemCount: number,
    explorationPercent: number,
  ) {
    if (itemCount <= 1) return 0;
    const normalizedExploration = this.clamp(explorationPercent, 0, 25) / 100;
    const stableSlot = (itemCount - deterministicIndex) / itemCount;
    return stableSlot * normalizedExploration;
  }

  private applyBrandDiversity(
    scored: ScoredMarketItem[],
    config: MarketRankingConfig,
  ) {
    const brandIds = new Set(
      scored.map(({ item }) => this.brandKey(item)).filter(Boolean),
    );
    if (scored.length < 3 || brandIds.size <= 1) {
      return scored;
    }

    const maxShare = this.clamp(config.brandMaxShare, 10, 50) / 100;
    const maxPerBrand = Math.max(1, Math.ceil(scored.length * maxShare));
    const kept: ScoredMarketItem[] = [];
    const deferred: ScoredMarketItem[] = [];
    const counts = new Map<string, number>();

    for (const scoredItem of scored) {
      const brandKey = this.brandKey(scoredItem.item);
      if (!brandKey) {
        kept.push(scoredItem);
        continue;
      }
      const count = counts.get(brandKey) ?? 0;
      if (count < maxPerBrand) {
        counts.set(brandKey, count + 1);
        kept.push(scoredItem);
      } else {
        deferred.push(scoredItem);
      }
    }

    return [...kept, ...deferred];
  }

  private brandKey(item: MarketSectionItemDto) {
    if (item.brand?.id) return item.brand.id;
    if (item.entityType === 'BRAND') return item.sourceId;
    return null;
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }
}
