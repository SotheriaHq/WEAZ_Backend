import { Injectable } from '@nestjs/common';
import { SearchQueryNormalizer } from './search-query-normalizer';
import {
  SEARCH_RANKING_TIERS,
  type SearchIdentityTier,
} from './search-match.types';
import type { SearchItem } from '../search.types';

@Injectable()
export class SearchRankingService {
  constructor(private readonly normalizer: SearchQueryNormalizer) {}

  identityTier(
    value: string | null | undefined,
    query: string,
  ): SearchIdentityTier {
    const normalized = this.normalizer.normalize(value);
    if (!normalized || !query) {
      return {
        tier: SEARCH_RANKING_TIERS.IDENTITY_FUZZY,
        reason: 'identity-fuzzy',
      };
    }
    if (normalized === query) {
      return {
        tier: SEARCH_RANKING_TIERS.EXACT_IDENTITY,
        reason: 'exact-identity-name',
      };
    }
    if (normalized.startsWith(query)) {
      return {
        tier: SEARCH_RANKING_TIERS.IDENTITY_PREFIX,
        reason: 'identity-prefix',
      };
    }
    if (normalized.includes(query)) {
      return {
        tier: SEARCH_RANKING_TIERS.IDENTITY_CONTAINS,
        reason: 'identity-contains',
      };
    }
    return {
      tier: SEARCH_RANKING_TIERS.IDENTITY_FUZZY,
      reason: 'identity-fuzzy',
    };
  }

  exactHandleTier(
    username: string | null | undefined,
    query: string,
  ): SearchIdentityTier | null {
    const compactQuery = this.normalizer.compactHandle(query);
    if (!compactQuery) {
      return null;
    }
    return this.normalizer.compactHandle(username) === compactQuery
      ? {
          tier: SEARCH_RANKING_TIERS.EXACT_IDENTITY,
          reason: 'exact-handle',
        }
      : null;
  }

  tierOf(item: SearchItem): number {
    return typeof item.matchTier === 'number'
      ? item.matchTier
      : SEARCH_RANKING_TIERS.COMMERCE;
  }
}
