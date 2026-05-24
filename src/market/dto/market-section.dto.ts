export type MarketSectionKey =
  | 'fresh-drops'
  | 'hot-right-now'
  | 'latest-collections'
  | 'shop-by-style'
  | 'custom-ready'
  | 'new-designers-to-watch';

export type MarketSectionSourceType =
  | 'PRODUCT'
  | 'COLLECTION'
  | 'DESIGN'
  | 'BRAND'
  | 'MIXED';

export type MarketSectionLayout =
  | 'HORIZONTAL_RAIL'
  | 'PRODUCT_GRID'
  | 'COLLECTION_RAIL'
  | 'CATEGORY_GRID'
  | 'BRAND_RAIL';

export interface MarketSectionMediaDto {
  url: string | null;
  thumbnailUrl: string | null;
  type: 'IMAGE' | 'VIDEO' | 'UNKNOWN';
  alt: string | null;
}

export interface MarketSectionBrandDto {
  id: string | null;
  name: string | null;
  logoUrl: string | null;
}

export interface MarketSectionPriceDto {
  amount: number | null;
  saleAmount: number | null;
  effectiveAmount: number | null;
  currency: string;
}

export interface MarketSectionPriceRangeDto {
  min: number | null;
  max: number | null;
  currency: string;
}

export interface MarketSectionAvailabilityDto {
  totalStock: number | null;
  customOrderEnabled: boolean;
  standardCheckoutEnabled: boolean;
  isOnSale: boolean;
}

export interface MarketSectionCategoryDto {
  id: string | null;
  slug: string | null;
  name: string | null;
}

export interface MarketSectionTargetDto {
  type: 'PRODUCT' | 'COLLECTION' | 'DESIGN' | 'BRAND' | 'CATEGORY';
  id: string | null;
  key: string | null;
  route: string | null;
}

export interface MarketSectionItemDto {
  id: string;
  sourceId: string;
  sourceType: MarketSectionSourceType;
  entityType: 'PRODUCT' | 'COLLECTION' | 'DESIGN' | 'BRAND' | 'CATEGORY';
  title: string;
  subtitle: string | null;
  description: string | null;
  brand: MarketSectionBrandDto | null;
  media: MarketSectionMediaDto | null;
  price: MarketSectionPriceDto | null;
  priceRange: MarketSectionPriceRangeDto | null;
  availability: MarketSectionAvailabilityDto | null;
  category: MarketSectionCategoryDto | null;
  tags: string[];
  stats: {
    views: number | null;
    threads: number | null;
    products: number | null;
  };
  target: MarketSectionTargetDto;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MarketSectionViewAllDto {
  enabled: boolean;
  key: MarketSectionKey;
  route: string;
  label: string;
}

export interface MarketSectionPaginationDto {
  limit: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}

export interface MarketSectionMetadataDto {
  ranking: 'deterministic-v1';
  personalization: 'disabled';
  minimumItems: number;
  previewItemLimit: number;
}

export interface MarketSectionDto {
  key: MarketSectionKey;
  title: string;
  subtitle: string | null;
  emotionalLabel: string | null;
  layout: MarketSectionLayout;
  sourceType: MarketSectionSourceType;
  items: MarketSectionItemDto[];
  viewAll: MarketSectionViewAllDto;
  pagination: MarketSectionPaginationDto;
  metadata: MarketSectionMetadataDto;
}

export interface MarketSectionsResponseDto {
  generatedAt: string;
  sections: MarketSectionDto[];
  metadata: {
    version: 'phase1.v1';
    personalization: 'disabled';
    cachePolicy: 'private-no-store';
  };
}

export interface MarketSectionDetailResponseDto {
  generatedAt: string;
  section: MarketSectionDto;
}
