import { Injectable, Logger } from '@nestjs/common';
import { RUNWAY_CATEGORIES } from '../collections/runway-categories';
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
    rankingProfileKey: 'runway-v2',
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
    rankingProfileKey: 'runway-v2',
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
      'Personalized fashion with diverse discovery for new users.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'runway-v2',
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
    id: 'african-casual',
    key: 'african-casual',
    label: 'African Casual',
    description: 'Contemporary everyday African fashion with explicit casual classification.',
    surface: 'DESIGN_FEED',
    rankingProfileKey: 'runway-v2',
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
    rankingProfileKey: 'runway-v2',
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
    const categories = (await this.getActiveCategories()).map(category => {
      const builtIn = RUNWAY_CATEGORIES.find(row => row.key === category.key);
      return builtIn ? { ...category, label: builtIn.label, requiresAuth: builtIn.requiresAuth } : category;
    });
    const visible = categories.filter(
      (category) => !category.requiresAuth || Boolean(options?.userId),
    );
    const designCategories = visible.filter(category => category.surface === 'DESIGN_FEED');
    const availableDefault = (preferred: string) => designCategories.find(category => category.key === preferred)?.key ?? designCategories[0]?.key ?? 'explore';

    return {
      generatedAt: new Date().toISOString(),
      categories: visible,
      defaults: {
        guest: availableDefault('explore'),
        authenticatedNewUser: availableDefault('discover'),
        authenticatedReturningUser: availableDefault('discover'),
        selected: availableDefault(options?.userId ? 'discover' : 'explore'),
      },
      metadata: {
        version: 'runway-v2',
        personalization: options?.userId ? 'interaction-affinity' : 'guest-discovery',
        cachePolicy: 'private-no-store',
      },
    };
  }

  private async getActiveCategories(): Promise<FeedCategoryView[]> {
    try {
      const rows = await this.prisma.feedCategory.findMany({
        orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }],
      });
      if (!rows.length) return FEED_CATEGORY_DEFAULTS;

      const paused = new Set(rows.filter(row => row.status === 'PAUSED' || row.status === 'ARCHIVED').map(row => row.key === 'african-style' ? 'african-casual' : row.key));
      const configured = rows.filter(row => row.status === 'ACTIVE').map((row) => ({
        id: row.id,
        key: row.key === 'african-style' ? 'african-casual' : row.key,
        label: row.key === 'african-style' || row.key === 'african-casual' ? 'African Casual' : row.label,
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
        status: 'ACTIVE' as const,
      }));
      const defaults = FEED_CATEGORY_DEFAULTS.filter(row => row.surface === 'DESIGN_FEED');
      const byKey = new Map(configured.map(row => [row.key, row]));
      for (const category of defaults) {
        if (paused.has(category.key)) continue;
        const existing = byKey.get(category.key);
        byKey.set(category.key, { ...category, ...existing, label: category.label, requiresAuth: category.requiresAuth, rankingProfileKey: category.rankingProfileKey });
      }
      return [...byKey.values()].sort((a, b) => a.displayOrder - b.displayOrder || a.key.localeCompare(b.key));
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
