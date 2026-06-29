import type { SearchEntityType } from '../search.types';

export type SearchQueryMode = 'default' | 'profile' | 'tag';

export type SearchIntent =
  | 'exact-handle'
  | 'identity'
  | 'design-content'
  | 'commerce'
  | 'tag'
  | 'generic-fuzzy';

export interface SearchQueryAnalysis {
  rawQuery: string;
  mode: SearchQueryMode;
  normalizedQuery: string;
  tokens: string[];
  distinctiveTokens: string[];
  importantTokens: string[];
  commerceGateTokens: string[];
  forcedTypes?: SearchEntityType[];
  intent: SearchIntent;
  isExactHandleQuery: boolean;
}

export interface SearchIdentityTier {
  tier: number;
  reason: string;
}

export const SEARCH_RANKING_TIERS = {
  EXACT_IDENTITY: 0,
  IDENTITY_PREFIX: 1,
  IDENTITY_CONTAINS: 2,
  IDENTITY_FUZZY: 3,
  CONTENT: 4,
  COMMERCE: 5,
  TAG: 6,
} as const;

export type SearchResultKind = 'identity' | 'commerce' | 'content' | 'tag';
