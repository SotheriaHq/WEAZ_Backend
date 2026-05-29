import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  AdminAuditAction,
  NotificationType,
  Role,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
import { UpsertSubCategoryDto } from './dto/upsert-sub-category.dto';
import { v4 as uuidv4 } from 'uuid';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import {
  DEFAULT_COLLECTION_CATEGORIES,
  DEFAULT_SUB_CATEGORIES,
  DEFAULT_FILTER_DIMENSIONS,
  LEGACY_CATEGORY_SLUGS,
  LEGACY_CATEGORY_TYPE_SLUGS,
  LEGACY_FILTER_DIMENSION_SLUGS,
} from './default-taxonomy';
import {
  assertGarmentCategoryTermAllowed,
  assertGarmentSubCategoryTermAllowed,
} from './taxonomy-governance';

type CatalogFilterEntityType =
  | 'COLLECTION'
  | 'STORE_COLLECTION'
  | 'DESIGN'
  | 'PRODUCT';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly adminAudit?: AdminAuditService,
  ) {}

  private normalizeRequiredDescription(
    value: string | null | undefined,
    label: string,
  ): string {
    const description = String(value ?? '').trim();
    if (!description) {
      throw new BadRequestException(`${label} requires a description.`);
    }
    return description;
  }

  private async recordTaxonomyAudit(params: {
    actorUserId?: string;
    action: AdminAuditAction;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  }) {
    if (!params.actorUserId || !this.adminAudit) return;
    await this.adminAudit.safeLog({
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: params.metadata,
      previousState: params.previousState,
      newState: params.newState,
    });
  }

  private async assertActiveCategoryNameAvailable(
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.collectionCategory.findFirst({
      where: {
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        'An active garment category with this name already exists.',
      );
    }
  }

  private async assertActiveSubCategoryNameAvailable(
    categoryId: string,
    name: string,
    excludeId?: string,
  ) {
    const existing = await this.prisma.collectionCategoryType.findFirst({
      where: {
        categoryId,
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        'An active garment type with this name already exists under this garment category.',
      );
    }
  }

  private async notifyAdminsOfTaxonomyAction(params: {
    action: string;
    message: string;
    actorUserId?: string;
    categoryId?: string;
    subCategoryId?: string;
  }) {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.SuperAdmin, Role.Admin] },
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    if (admins.length === 0) {
      return;
    }

    await Promise.all(
      admins.map((admin) =>
        this.notifications
          .create(admin.id, NotificationType.ADMIN_ACTION, {
            actorId: params.actorUserId,
            payload: {
              action: params.action,
              message: params.message,
              categoryId: params.categoryId,
              subCategoryId: params.subCategoryId,
              actorUserId: params.actorUserId,
              targetUrl: '/admin/taxonomy',
            },
          })
          .catch((error) => {
            this.logger.warn(
              `Failed to create taxonomy admin notification for ${admin.id}: ${
                error instanceof Error ? error.message : 'unknown error'
              }`,
            );
          }),
      ),
    );
  }

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

  async create(dto: UpsertCategoryDto, actorUserId?: string) {
    const name = dto.name.trim();
    assertGarmentCategoryTermAllowed(name);
    await this.assertActiveCategoryNameAvailable(name);
    const description = this.normalizeRequiredDescription(
      dto.description,
      'Garment category',
    );
    const slug = await this.generateUniqueSlug(dto.name);
    const id = uuidv4();
    const row = await this.prisma.collectionCategory.create({
      data: {
        id,
        slug,
        name,
        description,
        order: dto.order ?? 0,
        isActive: true,
      },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_CATEGORY_CREATED',
      message: `Category created: ${row.name}`,
      actorUserId,
      categoryId: row.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategory',
      targetId: row.id,
      metadata: { operation: 'category_created' },
      newState: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        order: row.order,
        isActive: row.isActive,
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

  async update(id: string, dto: UpsertCategoryDto, actorUserId?: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const data: any = {};
    if (dto.name && dto.name.trim() !== existing.name) {
      const nextName = dto.name.trim();
      assertGarmentCategoryTermAllowed(nextName);
      await this.assertActiveCategoryNameAvailable(nextName, id);
      data.name = nextName;
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.order !== undefined) {
      data.order = dto.order;
    }
    const nextDescription =
      data.description !== undefined ? data.description : existing.description;
    if (existing.isActive && !String(nextDescription ?? '').trim()) {
      throw new BadRequestException('Garment category requires a description.');
    }
    if (Object.keys(data).length === 0) {
      return existing;
    }
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data,
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_CATEGORY_UPDATED',
      message: `Category updated: ${updated.name}`,
      actorUserId,
      categoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategory',
      targetId: updated.id,
      metadata: { operation: 'category_updated' },
      previousState: {
        name: existing.name,
        description: existing.description,
        order: existing.order,
        isActive: existing.isActive,
      },
      newState: {
        name: updated.name,
        description: updated.description,
        order: updated.order,
        isActive: updated.isActive,
      },
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

  async activate(id: string, actorUserId?: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    if (existing.isActive) return existing;
    assertGarmentCategoryTermAllowed(existing.name);
    this.normalizeRequiredDescription(existing.description, 'Garment category');
    await this.assertActiveCategoryNameAvailable(existing.name, id);
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data: { isActive: true },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_CATEGORY_ACTIVATED',
      message: `Category activated: ${updated.name}`,
      actorUserId,
      categoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategory',
      targetId: updated.id,
      metadata: { operation: 'category_reactivated' },
      previousState: { isActive: existing.isActive },
      newState: { isActive: updated.isActive },
    });

    return updated;
  }

  async deactivate(id: string, actorUserId?: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    if (!existing.isActive) return existing;
    const updated = await this.prisma.collectionCategory.update({
      where: { id },
      data: { isActive: false },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_CATEGORY_DEACTIVATED',
      message: `Category deactivated: ${updated.name}`,
      actorUserId,
      categoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategory',
      targetId: updated.id,
      metadata: { operation: 'category_deactivated' },
      previousState: { isActive: existing.isActive },
      newState: { isActive: updated.isActive },
    });

    return updated;
  }

  async remove(id: string, actorUserId?: string) {
    const existing = await this.prisma.collectionCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');
    const [
      legacyDesignReferencing,
      explicitDesignReferencing,
      storeReferencing,
      productReferencing,
    ] = await Promise.all([
      this.prisma.collection.count({ where: { categoryId: id } }),
      this.prisma.design.count({ where: { categoryId: id } }),
      this.prisma.storeCollection.count({ where: { categoryId: id } }),
      this.prisma.product.count({ where: { categoryId: id } }),
    ]);
    if (
      legacyDesignReferencing > 0 ||
      explicitDesignReferencing > 0 ||
      storeReferencing > 0 ||
      productReferencing > 0
    )
      throw new BadRequestException(
        'Cannot delete category in use. Deactivate it instead to preserve existing item metadata.',
      );
    await this.prisma.collectionCategory.delete({ where: { id } });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_CATEGORY_DELETED',
      message: `Category deleted: ${existing.name}`,
      actorUserId,
      categoryId: existing.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategory',
      targetId: existing.id,
      metadata: { operation: 'category_deleted' },
      previousState: {
        slug: existing.slug,
        name: existing.name,
        description: existing.description,
        order: existing.order,
        isActive: existing.isActive,
      },
    });

    return { success: true };
  }

  private async generateUniqueSubCategorySlug(
    categoryId: string,
    base: string,
  ): Promise<string> {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]+/g, '')
        .replace(/\s+/g, '-');
    const baseSlug = normalize(base).slice(0, 60) || 'sub-category';
    let slug = baseSlug;
    let attempt = 1;

    while (true) {
      const exists = await this.prisma.collectionCategoryType.findFirst({
        where: { categoryId, slug },
        select: { id: true },
      });
      if (!exists) return slug;
      slug = `${baseSlug}-${attempt++}`;
      if (attempt > 50) {
        throw new BadRequestException(
          'Unable to generate unique sub-category slug',
        );
      }
    }
  }

  async createSubCategory(
    categoryId: string,
    dto: UpsertSubCategoryDto,
    actorUserId?: string,
  ) {
    const category = await this.prisma.collectionCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (!category.isActive) {
      throw new BadRequestException(
        'Create garment types under an active garment category.',
      );
    }

    const name = dto.name.trim();
    assertGarmentSubCategoryTermAllowed(name);
    await this.assertActiveSubCategoryNameAvailable(categoryId, name);
    const description = this.normalizeRequiredDescription(
      dto.description,
      'Garment type',
    );
    const slug = await this.generateUniqueSubCategorySlug(categoryId, name);

    const row = await this.prisma.collectionCategoryType.create({
      data: {
        id: uuidv4(),
        categoryId,
        slug,
        name,
        description,
        order: dto.order ?? 0,
        isActive: true,
      },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_SUBCATEGORY_CREATED',
      message: `Sub-category created: ${row.name}`,
      actorUserId,
      categoryId: row.categoryId,
      subCategoryId: row.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategoryType',
      targetId: row.id,
      metadata: {
        operation: 'subcategory_created',
        categoryId: row.categoryId,
      },
      newState: {
        categoryId: row.categoryId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        order: row.order,
        isActive: row.isActive,
      },
    });

    return {
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      order: row.order,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async updateSubCategory(
    subCategoryId: string,
    dto: UpsertSubCategoryDto,
    actorUserId?: string,
  ) {
    const existing = await this.prisma.collectionCategoryType.findUnique({
      where: { id: subCategoryId },
    });
    if (!existing) {
      throw new NotFoundException('Sub-category not found');
    }

    const data: any = {};
    if (dto.name && dto.name.trim() !== existing.name) {
      const nextName = dto.name.trim();
      assertGarmentSubCategoryTermAllowed(nextName);
      await this.assertActiveSubCategoryNameAvailable(
        existing.categoryId,
        nextName,
        subCategoryId,
      );
      data.name = nextName;
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.order !== undefined) {
      data.order = dto.order;
    }
    const nextDescription =
      data.description !== undefined ? data.description : existing.description;
    if (existing.isActive && !String(nextDescription ?? '').trim()) {
      throw new BadRequestException('Garment type requires a description.');
    }

    if (Object.keys(data).length === 0) {
      return existing;
    }

    const updated = await this.prisma.collectionCategoryType.update({
      where: { id: subCategoryId },
      data,
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_SUBCATEGORY_UPDATED',
      message: `Sub-category updated: ${updated.name}`,
      actorUserId,
      categoryId: updated.categoryId,
      subCategoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategoryType',
      targetId: updated.id,
      metadata: {
        operation: 'subcategory_updated',
        categoryId: updated.categoryId,
      },
      previousState: {
        name: existing.name,
        description: existing.description,
        order: existing.order,
        isActive: existing.isActive,
      },
      newState: {
        name: updated.name,
        description: updated.description,
        order: updated.order,
        isActive: updated.isActive,
      },
    });

    return {
      id: updated.id,
      categoryId: updated.categoryId,
      slug: updated.slug,
      name: updated.name,
      description: updated.description,
      order: updated.order,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async activateSubCategory(subCategoryId: string, actorUserId?: string) {
    const existing = await this.prisma.collectionCategoryType.findUnique({
      where: { id: subCategoryId },
    });
    if (!existing) {
      throw new NotFoundException('Sub-category not found');
    }
    if (existing.isActive) {
      return existing;
    }
    const category = await this.prisma.collectionCategory.findUnique({
      where: { id: existing.categoryId },
      select: { id: true, isActive: true },
    });
    if (!category?.isActive) {
      throw new BadRequestException(
        'Activate the parent garment category before activating this garment type.',
      );
    }
    assertGarmentSubCategoryTermAllowed(existing.name);
    this.normalizeRequiredDescription(existing.description, 'Garment type');
    await this.assertActiveSubCategoryNameAvailable(
      existing.categoryId,
      existing.name,
      subCategoryId,
    );
    const updated = await this.prisma.collectionCategoryType.update({
      where: { id: subCategoryId },
      data: { isActive: true },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_SUBCATEGORY_ACTIVATED',
      message: `Sub-category activated: ${updated.name}`,
      actorUserId,
      categoryId: updated.categoryId,
      subCategoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategoryType',
      targetId: updated.id,
      metadata: {
        operation: 'subcategory_reactivated',
        categoryId: updated.categoryId,
      },
      previousState: { isActive: existing.isActive },
      newState: { isActive: updated.isActive },
    });

    return updated;
  }

  async deactivateSubCategory(subCategoryId: string, actorUserId?: string) {
    const existing = await this.prisma.collectionCategoryType.findUnique({
      where: { id: subCategoryId },
    });
    if (!existing) {
      throw new NotFoundException('Sub-category not found');
    }
    if (!existing.isActive) {
      return existing;
    }
    const updated = await this.prisma.collectionCategoryType.update({
      where: { id: subCategoryId },
      data: { isActive: false },
    });

    await this.notifyAdminsOfTaxonomyAction({
      action: 'TAXONOMY_SUBCATEGORY_DEACTIVATED',
      message: `Sub-category deactivated: ${updated.name}`,
      actorUserId,
      categoryId: updated.categoryId,
      subCategoryId: updated.id,
    });
    await this.recordTaxonomyAudit({
      actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_WRITE,
      targetType: 'CollectionCategoryType',
      targetId: updated.id,
      metadata: {
        operation: 'subcategory_deactivated',
        categoryId: updated.categoryId,
      },
      previousState: { isActive: existing.isActive },
      newState: { isActive: updated.isActive },
    });

    return updated;
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
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            order: true,
          },
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
  async getSubCategoriesByCategoryId(
    categoryId: string,
    includeInactive = false,
  ) {
    const types = await this.prisma.collectionCategoryType.findMany({
      where: includeInactive ? { categoryId } : { categoryId, isActive: true },
      orderBy: [{ order: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        order: true,
      },
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
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            order: true,
          },
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
   * Set filter values for an entity (collection, store collection, design, or product).
   * Replaces all existing filters of the given entity with the new set.
   */
  private normalizeFilterValueIds(filterValueIds?: string[] | null): string[] {
    if (!Array.isArray(filterValueIds)) return [];
    return Array.from(
      new Set(
        filterValueIds
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  async validateEntityFilterValues(
    entityType: CatalogFilterEntityType,
    filterValueIds: string[],
  ): Promise<string[]> {
    const uniqueFilterValueIds = this.normalizeFilterValueIds(filterValueIds);
    if (uniqueFilterValueIds.length === 0) return [];

    const values = await this.prisma.filterValue.findMany({
      where: { id: { in: uniqueFilterValueIds } },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        dimension: {
          select: {
            id: true,
            slug: true,
            name: true,
            isActive: true,
            appliesTo: true,
          },
        },
      },
    });

    const valuesById = new Map(values.map((value) => [value.id, value]));
    const missingIds = uniqueFilterValueIds.filter((id) => !valuesById.has(id));
    const invalidValues = values.filter((value) => {
      const appliesTo = Array.isArray(value.dimension?.appliesTo)
        ? value.dimension.appliesTo
        : [];
      return (
        !value.isActive ||
        !value.dimension ||
        !value.dimension.isActive ||
        !appliesTo.includes(entityType)
      );
    });

    if (missingIds.length > 0 || invalidValues.length > 0) {
      this.logger.warn(
        `Invalid discovery metadata for ${entityType}: missing=${missingIds.join(',') || 'none'} invalid=${
          invalidValues
            .map(
              (value) =>
                `${value.id}:${value.dimension?.slug ?? 'no-dimension'}/${value.slug}`,
            )
            .join(',') || 'none'
        }`,
      );
      throw new BadRequestException(
        'Some selected style details are invalid for this item type.',
      );
    }

    return uniqueFilterValueIds;
  }

  async setEntityFilters(
    entityType: CatalogFilterEntityType,
    entityId: string,
    filterValueIds: string[],
  ) {
    const validFilterValueIds = await this.validateEntityFilterValues(
      entityType,
      filterValueIds,
    );

    await this.prisma.entityFilter.deleteMany({
      where: { entityType, entityId },
    });

    if (validFilterValueIds.length === 0) return [];

    const records = validFilterValueIds.map((filterValueId) => ({
      id: uuidv4(),
      filterValueId,
      entityType: entityType as any,
      entityId,
      ...(entityType === 'PRODUCT' ? { productId: entityId } : {}),
      ...(entityType === 'DESIGN' ? { designId: entityId } : {}),
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
    entityType: 'COLLECTION' | 'STORE_COLLECTION' | 'DESIGN' | 'PRODUCT',
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
    const activeNewSlugs = new Set(
      DEFAULT_COLLECTION_CATEGORIES.map((c) => c.slug),
    );
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
    for (const [parentSlug, subCategories] of Object.entries(
      DEFAULT_SUB_CATEGORIES,
    )) {
      const categoryId = categoryIdsBySlug.get(parentSlug);
      if (!categoryId) {
        this.logger.warn(`Parent category not found for slug: ${parentSlug}`);
        continue;
      }

      for (const sub of subCategories) {
        const existingType = await this.prisma.collectionCategoryType.findFirst(
          {
            where: { categoryId, slug: sub.slug },
            select: { id: true },
          },
        );

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

    const activeTypeKeys = new Set<string>();
    for (const [categoryId, activeSlugs] of activeSlugsPerCategory.entries()) {
      for (const slug of activeSlugs) {
        activeTypeKeys.add(`${categoryId}:${slug}`);
      }
    }

    const allTypes = await this.prisma.collectionCategoryType.findMany({
      where: {
        isActive: true,
        OR: [
          { slug: { in: LEGACY_CATEGORY_TYPE_SLUGS } },
          { category: { slug: { in: LEGACY_CATEGORY_SLUGS } } },
        ],
      },
      select: {
        id: true,
        slug: true,
        categoryId: true,
        category: { select: { slug: true } },
      },
    });

    for (const type of allTypes) {
      if (activeTypeKeys.has(`${type.categoryId}:${type.slug}`)) continue;
      const isLegacyType = LEGACY_CATEGORY_TYPE_SLUGS.includes(type.slug);
      const isUnderLegacyCategory = LEGACY_CATEGORY_SLUGS.includes(
        type.category.slug,
      );
      if (isLegacyType || isUnderLegacyCategory) {
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

      const activeValueSlugs = dim.values.map((value) => value.slug);
      const deactivatedValues = await this.prisma.filterValue.updateMany({
        where: {
          dimensionId,
          isActive: true,
          slug: { notIn: activeValueSlugs },
        },
        data: { isActive: false },
      });
      if (deactivatedValues.count > 0) {
        this.logger.log(
          `Deactivated ${deactivatedValues.count} obsolete values in filter dimension: ${dim.slug}`,
        );
      }
    }

    const activeDimensionSlugs = DEFAULT_FILTER_DIMENSIONS.map(
      (dim) => dim.slug,
    );
    const legacyFilterSlugs = LEGACY_FILTER_DIMENSION_SLUGS.filter(
      (slug) => !activeDimensionSlugs.includes(slug),
    );
    if (legacyFilterSlugs.length > 0) {
      const deactivatedDimensions =
        await this.prisma.filterDimension.updateMany({
          where: { slug: { in: legacyFilterSlugs }, isActive: true },
          data: { isActive: false },
        });
      if (deactivatedDimensions.count > 0) {
        this.logger.log(
          `Deactivated ${deactivatedDimensions.count} legacy filter dimensions: ${legacyFilterSlugs.join(', ')}`,
        );
      }
    }
  }
}
