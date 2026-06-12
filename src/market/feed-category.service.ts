import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

export type FeedCategoryView = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  surface: 'DESIGN_FEED' | 'MARKET_HOME';
  rankingProfileKey: string | null;
  displayOrder: number;
  fallbackCategoryKey: string;
  requiresAuth: boolean;
  requiresPersonalization: boolean;
  isDefaultForGuest: boolean;
  isDefaultForNewUser: boolean;
  isDefaultForReturningUser: boolean;
  status: 'ACTIVE';
};

const FEED_CATEGORY_DEFAULTS: FeedCategoryView[] = [
  {
    id: 'discover',
    key: 'discover',
    label: 'Discover',
    description: 'Broad runway/design discovery for authenticated new users.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 10,
    fallbackCategoryKey: 'explore',
    requiresAuth: false,
    requiresPersonalization: false,
    isDefaultForGuest: false,
    isDefaultForNewUser: true,
    isDefaultForReturningUser: false,
    status: 'ACTIVE',
  },
  {
    id: 'explore',
    key: 'explore',
    label: 'Explore',
    description: 'Guest-safe broad design exploration.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 20,
    fallbackCategoryKey: 'discover',
    requiresAuth: false,
    requiresPersonalization: false,
    isDefaultForGuest: true,
    isDefaultForNewUser: false,
    isDefaultForReturningUser: true,
    status: 'ACTIVE',
  },
  {
    id: 'for-you',
    key: 'for-you',
    label: 'For You',
    description:
      'Reserved personalization category; deterministic fallback until ranking ships.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 30,
    fallbackCategoryKey: 'discover',
    requiresAuth: true,
    requiresPersonalization: true,
    isDefaultForGuest: false,
    isDefaultForNewUser: false,
    isDefaultForReturningUser: false,
    status: 'ACTIVE',
  },
  {
    id: 'african-style',
    key: 'african-style',
    label: 'African Style',
    description: 'African fashion inspiration lane.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 40,
    fallbackCategoryKey: 'explore',
    requiresAuth: false,
    requiresPersonalization: false,
    isDefaultForGuest: false,
    isDefaultForNewUser: false,
    isDefaultForReturningUser: false,
    status: 'ACTIVE',
  },
  {
    id: 'casual-style',
    key: 'casual-style',
    label: 'Casual Style',
    description: 'Casual fashion inspiration lane.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 50,
    fallbackCategoryKey: 'explore',
    requiresAuth: false,
    requiresPersonalization: false,
    isDefaultForGuest: false,
    isDefaultForNewUser: false,
    isDefaultForReturningUser: false,
    status: 'ACTIVE',
  },
];

@Injectable()
export class FeedCategoryService {
  private readonly logger = new Logger(FeedCategoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listCategories(options?: { userId?: string | null }) {
    const categories = await this.getActiveCategories();
    const visible = categories.filter(
      (category) => !category.requiresAuth || Boolean(options?.userId),
    );

    return {
      generatedAt: new Date().toISOString(),
      categories: visible,
      defaults: {
        guest: 'explore',
        authenticatedNewUser: 'discover',
        authenticatedReturningUser: 'explore',
        selected: options?.userId ? 'discover' : 'explore',
      },
      metadata: {
        version: 'phase2.foundation',
        personalization: 'disabled',
        cachePolicy: 'private-no-store',
      },
    };
  }

  private async getActiveCategories(): Promise<FeedCategoryView[]> {
    try {
      const rows = await this.prisma.feedCategory.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }],
      });
      if (!rows.length) return FEED_CATEGORY_DEFAULTS;

      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        label: row.label,
        description: row.description,
        surface: row.surface as FeedCategoryView['surface'],
        rankingProfileKey: row.rankingProfileKey,
        displayOrder: row.displayOrder,
        fallbackCategoryKey: row.fallbackCategoryKey ?? 'explore',
        requiresAuth: row.requiresAuth,
        requiresPersonalization: row.requiresPersonalization,
        isDefaultForGuest: row.isDefaultForGuest,
        isDefaultForNewUser: row.isDefaultForNewUser,
        isDefaultForReturningUser: row.isDefaultForReturningUser,
        status: 'ACTIVE',
      }));
    } catch (error) {
      this.logger.warn(
        `Feed category config read failed, using code defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return FEED_CATEGORY_DEFAULTS;
    }
  }
}
