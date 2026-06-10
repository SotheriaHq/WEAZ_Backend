import type { CatalogEntityType } from '../common/domain/catalog-domain';

export const SEARCH_ENTITY_TYPES = [
  'profile',
  'product',
  'brand',
  'design',
  'collection',
  'tag',
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export interface SearchHighlightOffset {
  start: number;
  end: number;
}

export interface SearchItem {
  id: string;
  type: SearchEntityType;
  entityType?: CatalogEntityType;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  href: string;
  score: number;
  price?: number | null;
  salePrice?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
  highlights?: {
    title?: SearchHighlightOffset[];
    description?: SearchHighlightOffset[];
  };
}

export interface SearchResponse {
  query: string;
  normalizedQuery: string;
  types: SearchEntityType[];
  items: SearchItem[];
  counts: Record<SearchEntityType, number>;
  meta: {
    page: number;
    limit: number;
    hasNextPage: boolean;
    paginationMode?: 'single' | 'mixed';
  };
}

export interface SearchSuggestionSection {
  items: SearchItem[];
  total: number;
}

export interface SearchSuggestionResponse {
  query: string;
  normalizedQuery: string;
  recent: Array<{ query: string; href: string }>;
  trending: Array<{ query: string; score: number; href: string }>;
  products: SearchSuggestionSection;
  profiles: SearchSuggestionSection;
  brands: SearchSuggestionSection;
  designs: SearchSuggestionSection;
  storeCollections: SearchSuggestionSection;
  tags: Array<{
    id: string;
    type: 'tag';
    title: string;
    href: string;
    score: number;
  }>;
}

export interface SearchHealthResponse {
  postgres: {
    ready: boolean;
  };
  redis: {
    ready: boolean;
    degraded: boolean;
    circuitOpen: boolean;
    suggestionIndexCounts?: Record<string, number>;
  };
  mode: 'database-only' | 'database-and-redis';
}
