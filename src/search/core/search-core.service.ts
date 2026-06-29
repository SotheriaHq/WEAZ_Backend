import { Injectable } from '@nestjs/common';
import type { SearchEntityType } from '../search.types';
import {
  type SearchIdentityTier,
  type SearchQueryAnalysis,
  type SearchQueryMode,
  SEARCH_RANKING_TIERS,
} from './search-match.types';
import { SearchQueryNormalizer } from './search-query-normalizer';
import { SearchRankingService } from './search-ranking.service';
import { SearchTokenService } from './search-token.service';
import { SearchVisibilityService } from './search-visibility.service';

@Injectable()
export class SearchCoreService {
  constructor(
    private readonly normalizer: SearchQueryNormalizer = new SearchQueryNormalizer(),
    private readonly tokenService: SearchTokenService = new SearchTokenService(),
    private readonly rankingService: SearchRankingService = new SearchRankingService(
      normalizer,
    ),
    public readonly visibility: SearchVisibilityService = new SearchVisibilityService(),
  ) {}

  normalizeQuery(raw?: string | null): string {
    return this.normalizer.normalize(raw);
  }

  compactHandleQuery(raw?: string | null): string {
    return this.normalizer.compactHandle(raw);
  }

  tokenize(query: string): string[] {
    return this.tokenService.tokenize(query);
  }

  significantTokens(tokens: string[]): string[] {
    return this.tokenService.significantTokens(tokens);
  }

  commerceGateTokens(tokens: string[]): string[] {
    return this.tokenService.commerceGateTokens(tokens);
  }

  analyzeQuery(queryInput?: string | null): SearchQueryAnalysis {
    const rawQuery = String(queryInput || '').trim();
    if (!rawQuery) {
      return {
        rawQuery,
        mode: 'default',
        normalizedQuery: '',
        tokens: [],
        distinctiveTokens: [],
        importantTokens: [],
        commerceGateTokens: [],
        intent: 'generic-fuzzy',
        isExactHandleQuery: false,
      };
    }

    let mode: SearchQueryMode = 'default';
    let workingQuery = rawQuery;

    if (workingQuery.startsWith('@')) {
      mode = 'profile';
      workingQuery = workingQuery.slice(1).trim();
    } else if (workingQuery.startsWith('/') || workingQuery.startsWith('#')) {
      mode = 'tag';
      workingQuery = workingQuery.slice(1).trim();
    }

    const normalizedQuery = this.normalizeQuery(workingQuery);
    const tokens = this.tokenize(normalizedQuery);
    const distinctiveTokens = this.tokenService.distinctiveTokens(tokens);
    const importantTokens = this.tokenService.importantTokens(tokens);
    const commerceGateTokens = this.tokenService.commerceGateTokens(tokens);
    const forcedTypes =
      mode === 'profile'
        ? (['profile'] as SearchEntityType[])
        : mode === 'tag'
          ? (['tag'] as SearchEntityType[])
          : undefined;

    return {
      rawQuery,
      mode,
      normalizedQuery,
      tokens,
      distinctiveTokens,
      importantTokens,
      commerceGateTokens,
      forcedTypes,
      intent: this.resolveIntent(mode, rawQuery, tokens),
      isExactHandleQuery: rawQuery.startsWith('@') && tokens.length === 1,
    };
  }

  identityTier(
    value: string | null | undefined,
    query: string,
  ): SearchIdentityTier {
    return this.rankingService.identityTier(value, query);
  }

  exactHandleTier(
    username: string | null | undefined,
    query: string,
  ): SearchIdentityTier | null {
    return this.rankingService.exactHandleTier(username, query);
  }

  tierOf(item: { matchTier?: number }): number {
    return typeof item.matchTier === 'number'
      ? item.matchTier
      : SEARCH_RANKING_TIERS.COMMERCE;
  }

  matchedTokens(
    tokens: string[],
    ...values: Array<string | string[] | null | undefined>
  ): string[] {
    const haystack = this.normalizeQuery(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter(Boolean)
        .join(' '),
    );
    if (!haystack) {
      return [];
    }
    return tokens.filter((token) => haystack.includes(token));
  }

  private resolveIntent(
    mode: SearchQueryMode,
    rawQuery: string,
    tokens: string[],
  ) {
    if (mode === 'profile' || rawQuery.startsWith('@')) {
      return 'exact-handle' as const;
    }
    if (mode === 'tag') {
      return 'tag' as const;
    }
    if (tokens.length > 1) {
      return 'identity' as const;
    }
    return 'generic-fuzzy' as const;
  }
}
