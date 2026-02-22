import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_SUB_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
  LEGACY_CATEGORY_SLUGS,
  LEGACY_CATEGORY_TYPE_SLUGS,
} from './default-taxonomy';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(private readonly prisma: PrismaService) { }

  // =====================
  // Admin — Main Categories
  // =====================

  async adminList(includeInactive = false) {
    const rows = await this.prisma.collectionCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      isActive: r.isActive,
      order: r.order,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  private async generateUniqueSlug(base: string): Promise<string> {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]+/g, '')
        .replace(/\s+/g, '-');
    let slug = normalize(base).slice(0, 60) || 'category';
    let attempt = 1;
    while (true) {
      const exists = await this.prisma.collectionCategory.findUnique({
        where: { slug },
      });
      if (!exists) return slug;
      slug = `${slug}-${attempt++}`;
      if (attempt > 50)
        throw new BadRequestException('Unable to generate unique slug');
    }
  }

  async create(dto: UpsertCategoryDto) {
    const slug = await this.generateUniqueSlug(dto.name);
    const id = uuidv4();
    const row = await this.prisma.collectionCategory.create({
      data: {
        id,
        slug,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        order: dto.order ?? 0,
        isActive: true,
      },
    });
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      isActive: row.isActive,
      order: row.order,
    };
  }

  async update(id: string, dto: UpsertCategoryDto) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const data: any = {};
    if (dto.name && dto.name.trim() !== existing.name) {
      data.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.order !== undefined) {
      data.order = dto.order;
    }
    if (Object.keys(data).length === 0) {
      return existing;
    }
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data,
    });
    return {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      description: updated.description,
      isActive: updated.isActive,
      order: updated.order,
    };
  }

  async activate(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    if (existing.isActive) return existing;
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data: { isActive: true },
    });
    return updated;
  }

  async deactivate(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    if (!existing.isActive) return existing;
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data: { isActive: false },
    });
    return updated;
  }

  async remove(id: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const [designReferencing, storeReferencing] = await Promise.all([
      this.prisma.collection.count({ where: { categoryId: id } }),
      this.prisma.storeCollection.count({ where: { categoryId: id } }),
    ]);
    if (designReferencing > 0 || storeReferencing > 0)
      throw new BadRequestException('Cannot delete category in use');
    await this.prisma.collectionCategory.delete({ where: { id } });
    return { success: true };
  }

  // =====================
  // Public — Categories & Sub-Categories
  // =====================

  /**
   * List all active main categories with their sub-categories.
   */
  async listCategoriesWithSubCategories() {
    const categories = await this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }],
      include: {
        types: {
          where: { isActive: true },
          orderBy: [{ order: 'asc' }],
          select: { id: true, slug: true, name: true, description: true, order: true },
        },
      },
    });
    return categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      order: c.order,
      subCategories: c.types,
    }));
  }

  /**
   * Get sub-categories for a specific main category.
   */
  async getSubCategoriesByCategoryId(categoryId: string) {
    const types = await this.prisma.collectionCategoryType.findMany({
      where: { categoryId, isActive: true },
      orderBy: [{ order: 'asc' }],
      select: { id: true, slug: true, name: true, description: true, order: true },
    });
    return types;
  }

  // =====================
  // Public — Filter Dimensions
  // =====================

  /**
   * List all active filter dimensions with their values.
   * Used by creation forms to populate filter selectors.
   */
  async getFilterDimensions() {
    const dimensions = await this.prisma.filterDimension.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }],
      include: {
        values: {
          where: { isActive: true },
          orderBy: [{ order: 'asc' }],
          select: { id: true, slug: true, name: true, description: true, order: true },
        },
      },
    });
    return dimensions.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      isMulti: d.isMulti,
      appliesTo: d.appliesTo,
      values: d.values,
    }));
  }

  // =====================
  // Entity Filter Management
  // =====================

  /**
   * Set filter values for an entity (collection or product).
   * Replaces all existing filters of the given entity with the new set.
   */
  async setEntityFilters(
    entityType: 'COLLECTION' | 'STORE_COLLECTION' | 'PRODUCT',
    entityId: string,
    filterValueIds: string[],
  ) {
    // Remove existing filters for this entity
    await this.prisma.entityFilter.deleteMany({
      where: { entityType, entityId },
    });

    if (filterValueIds.length === 0) return [];

    // Validate all filter value IDs exist
    const validValues = await this.prisma.filterValue.findMany({
      where: { id: { in: filterValueIds }, isActive: true },
      select: { id: true },
    });
    const validIds = new Set(validValues.map((v) => v.id));

    // Create new entity filter records
    const records = filterValueIds
      .filter((id) => validIds.has(id))
      .map((filterValueId) => ({
        id: uuidv4(),
        filterValueId,
        entityType: entityType as any,
        entityId,
        ...(entityType === 'PRODUCT' ? { productId: entityId } : {}),
      }));

    if (records.length > 0) {
      await this.prisma.entityFilter.createMany({ data: records });
    }

    return records.map((r) => r.filterValueId);
  }

  /**
   * Get filter values applied to a specific entity.
   */
  async getEntityFilters(
    entityType: 'COLLECTION' | 'STORE_COLLECTION' | 'PRODUCT',
    entityId: string,
  ) {
    const filters = await this.prisma.entityFilter.findMany({
      where: { entityType, entityId },
      include: {
        filterValue: {
          include: {
            dimension: {
              select: { id: true, slug: true, name: true, isMulti: true },
            },
          },
        },
      },
    });
    return filters.map((f) => ({
      dimensionId: f.filterValue.dimension.id,
      dimensionSlug: f.filterValue.dimension.slug,
      dimensionName: f.filterValue.dimension.name,
      valueId: f.filterValue.id,
      valueSlug: f.filterValue.slug,
      valueName: f.filterValue.name,
    }));
  }

  // =====================
  // Bootstrap — Seed Default Taxonomy
  // =====================

  async ensureDefaultTaxonomy() {
    const categoryIdsBySlug = new Map<string, string>();

    // 1. Upsert main categories
    for (const category of DEFAULT_COLLECTION_CATEGORIES) {
      const existing = await this.prisma.collectionCategory.findUnique({
        where: { slug: category.slug },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.collectionCategory.update({
          where: { id: existing.id },
          data: {
            name: category.name,
            description: category.description,
            order: category.order,
            isActive: true,
          },
        });
        categoryIdsBySlug.set(category.slug, existing.id);
      } else {
        const created = await this.prisma.collectionCategory.create({
          data: {
            id: uuidv4(),
            slug: category.slug,
            name: category.name,
            description: category.description,
            order: category.order,
            isActive: true,
          },
          select: { id: true },
        });
        categoryIdsBySlug.set(category.slug, created.id);
      }
    }

    // 2. Deactivate legacy categories (don't delete to preserve FK integrity)
    const activeNewSlugs = new Set(DEFAULT_COLLECTION_CATEGORIES.map((c) => c.slug));
    for (const legacySlug of LEGACY_CATEGORY_SLUGS) {
      if (activeNewSlugs.has(legacySlug)) continue;
      const legacy = await this.prisma.collectionCategory.findUnique({
        where: { slug: legacySlug },
      });
      if (legacy && legacy.isActive) {
        await this.prisma.collectionCategory.update({
          where: { id: legacy.id },
          data: { isActive: false },
        });
        this.logger.log(`Deactivated legacy category: ${legacySlug}`);
      }
    }

    // 3. Upsert sub-categories (scoped per main category)
    for (const [parentSlug, subCategories] of Object.entries(DEFAULT_SUB_CATEGORIES)) {
      const categoryId = categoryIdsBySlug.get(parentSlug);
      if (!categoryId) {
        this.logger.warn(`Parent category not found for slug: ${parentSlug}`);
        continue;
      }

      for (const sub of subCategories) {
        const existingType = await this.prisma.collectionCategoryType.findFirst({
          where: { categoryId, slug: sub.slug },
          select: { id: true },
        });

        if (existingType) {
          await this.prisma.collectionCategoryType.update({
            where: { id: existingType.id },
            data: {
              name: sub.name,
              description: sub.description ?? null,
              order: sub.order,
              isActive: true,
            },
          });
        } else {
          await this.prisma.collectionCategoryType.create({
            data: {
              id: uuidv4(),
              categoryId,
              slug: sub.slug,
              name: sub.name,
              description: sub.description ?? null,
              order: sub.order,
              isActive: true,
            },
          });
        }
      }
    }

    // 4. Deactivate legacy category types not in new taxonomy
    const activeSlugsPerCategory = new Map<string, Set<string>>();
    for (const [parentSlug, subs] of Object.entries(DEFAULT_SUB_CATEGORIES)) {
      const categoryId = categoryIdsBySlug.get(parentSlug);
      if (!categoryId) continue;
      activeSlugsPerCategory.set(categoryId, new Set(subs.map((s) => s.slug)));
    }

    const allTypes = await this.prisma.collectionCategoryType.findMany({
      where: { isActive: true },
      select: { id: true, slug: true, categoryId: true },
    });

    for (const type of allTypes) {
      const activeForCategory = activeSlugsPerCategory.get(type.categoryId);
      // If this type doesn't belong to any active category, or its slug is not in the new set
      if (!activeForCategory || !activeForCategory.has(type.slug)) {
        await this.prisma.collectionCategoryType.update({
          where: { id: type.id },
          data: { isActive: false },
        });
        this.logger.log(`Deactivated legacy category type: ${type.slug}`);
      }
    }

    // 5. Upsert filter dimensions and their values
    await this.seedFilterDimensions();

    this.logger.log(
      `Default taxonomy ensured: ${DEFAULT_COLLECTION_CATEGORIES.length} categories, ` +
      `${Object.values(DEFAULT_SUB_CATEGORIES).reduce((a, s) => a + s.length, 0)} sub-categories, ` +
      `${DEFAULT_FILTER_DIMENSIONS.length} filter dimensions.`,
    );
  }

  private async seedFilterDimensions() {
    for (const dim of DEFAULT_FILTER_DIMENSIONS) {
      let dimensionId: string;

      const existing = await this.prisma.filterDimension.findUnique({
        where: { slug: dim.slug },
        select: { id: true },
      });

      if (existing) {
        await this.prisma.filterDimension.update({
          where: { id: existing.id },
          data: {
            name: dim.name,
            description: dim.description,
            order: dim.order,
            isMulti: dim.isMulti,
            appliesTo: dim.appliesTo,
            isActive: true,
          },
        });
        dimensionId = existing.id;
      } else {
        const created = await this.prisma.filterDimension.create({
          data: {
            id: uuidv4(),
            slug: dim.slug,
            name: dim.name,
            description: dim.description,
            order: dim.order,
            isMulti: dim.isMulti,
            appliesTo: dim.appliesTo,
            isActive: true,
          },
          select: { id: true },
        });
        dimensionId = created.id;
      }

      // Upsert values for this dimension
      for (const val of dim.values) {
        const existingValue = await this.prisma.filterValue.findFirst({
          where: { dimensionId, slug: val.slug },
          select: { id: true },
        });

        if (existingValue) {
          await this.prisma.filterValue.update({
            where: { id: existingValue.id },
            data: {
              name: val.name,
              order: val.order,
              isActive: true,
            },
          });
        } else {
          await this.prisma.filterValue.create({
            data: {
              id: uuidv4(),
              dimensionId,
              slug: val.slug,
              name: val.name,
              order: val.order,
              isActive: true,
            },
          });
        }
      }
    }
  }
}
