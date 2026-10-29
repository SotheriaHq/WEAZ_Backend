import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
  Optional,
  Logger,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
import {
  ModerateCategorySuggestionDto,
  ModerationDecision,
} from './dto/moderate-category-suggestion.dto';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { TAXONOMY_PROPOSAL_NAME } from './taxonomy-proposal-name';
import { CollectionsService } from '../../collections/collections.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import {
  assertGarmentCategoryTermAllowed,
  assertGarmentSubCategoryTermAllowed,
  getBlockedTaxonomyGuidance,
  normalizeTaxonomySlug,
} from '../taxonomy-governance';
// Use local types to avoid build-time coupling to generated Prisma enums
export type CategorySuggestionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface SuggestionResponse {
  id: string;
  name: string;
  slug: string;
  garmentTypeName?: string | null;
  garmentTypeSlug?: string;
  description?: string | null;
  status: CategorySuggestionStatus;
  rejectionReason?: string | null;
  approvedCategoryId?: string | null;
  approvedCategoryTypeId?: string | null;
  proposedByUserId: string;
  decisionByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt?: Date | null;
}

@Injectable()
export class CategorySuggestionsService {
  private readonly logger = new Logger(CategorySuggestionsService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CollectionsService))
    private readonly collectionsService: CollectionsService,
    @Optional() private readonly adminAudit?: AdminAuditService,
  ) {}

  private normalizeSlug(base: string): string {
    const normalized = base.normalize('NFKC').trim();
    const slug = normalizeTaxonomySlug(normalized);
    return slug === 'taxonomy-item'
      ? `${slug}-${createHash('sha256').update(normalized.toLowerCase()).digest('hex').slice(0, 12)}`
      : slug;
  }

  private toResponse(row: any): SuggestionResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      garmentTypeName: row.garmentTypeName,
      garmentTypeSlug: row.garmentTypeSlug,
      description: row.description,
      status: row.status,
      rejectionReason: row.rejectionReason,
      approvedCategoryId: row.approvedCategoryId,
      approvedCategoryTypeId: row.approvedCategoryTypeId,
      proposedByUserId: row.proposedByUserId,
      decisionByUserId: row.decisionByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      decidedAt: row.decidedAt,
    };
  }

  async submit(userId: string, dto: SubmitCategorySuggestionDto) {
    const name = dto.name.trim();
    if (!TAXONOMY_PROPOSAL_NAME.test(name)) {
      throw new BadRequestException(
        'Use 2–48 letters, numbers or ordinary name punctuation for the category.',
      );
    }
    assertGarmentCategoryTermAllowed(name);
    const proposedSlug = this.normalizeSlug(name);
    const garmentTypeName = dto.garmentTypeName?.trim() || null;
    if (
      dto.garmentTypeName !== undefined &&
      (!garmentTypeName || !TAXONOMY_PROPOSAL_NAME.test(garmentTypeName))
    )
      throw new BadRequestException(
        'Use 2–48 letters, numbers or ordinary name punctuation for the garment type.',
      );
    if (garmentTypeName) assertGarmentSubCategoryTermAllowed(garmentTypeName);
    const garmentTypeSlug = garmentTypeName
      ? this.normalizeSlug(garmentTypeName)
      : '';

    const row = await this.prisma.$transaction(
      async (tx) => {
        // Same-brand concurrent requests share the quota lock; same-slug requests share identity.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`category-request-user:${userId}`},0))`;
        const named = await tx.collectionCategory.findMany({
          where: {
            isActive: true,
            name: { equals: name, mode: 'insensitive' },
          },
          select: { slug: true },
          take: 2,
        });
        if (named.length > 1)
          throw new BadRequestException(
            'Multiple approved categories have this name. Ask WIEZ to resolve the taxonomy before proposing a garment type.',
          );
        const slug = named[0]?.slug ?? proposedSlug;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`category-request-slug:${slug}`},0))`;
        const existingCategory = await tx.collectionCategory.findUnique({
          where: { slug },
        });
        if (
          existingCategory &&
          existingCategory.name.normalize('NFKC').toLowerCase() !==
            name.normalize('NFKC').toLowerCase()
        )
          throw new BadRequestException(
            'This category name conflicts with an existing category identifier. Choose a more specific garment category name.',
          );
        if (
          existingCategory &&
          (!garmentTypeName ||
            (await tx.collectionCategoryType.findUnique({
              where: {
                categoryId_slug: {
                  categoryId: existingCategory.id,
                  slug: garmentTypeSlug,
                },
              },
            })))
        )
          throw new BadRequestException(
            'A category with this name already exists',
          );
        const existing = await tx.collectionCategorySuggestion.findUnique({
          where: { slug_garmentTypeSlug: { slug, garmentTypeSlug } },
        });
        if (existing)
          throw new BadRequestException(
            existing.status === 'PENDING'
              ? 'A pending suggestion with this name already exists'
              : 'This category suggestion has already been reviewed',
          );
        const recentCount = await tx.collectionCategorySuggestion.count({
          where: {
            proposedByUserId: userId,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });
        if (recentCount >= 5)
          throw new BadRequestException(
            'Rate limit exceeded: please wait before submitting more suggestions',
          );
        return tx.collectionCategorySuggestion.create({
          data: {
            id: uuidv4(),
            name,
            slug,
            garmentTypeName,
            garmentTypeSlug,
            description: dto.description?.trim() || null,
            proposedByUserId: userId,
            status: 'PENDING',
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.toResponse(row);
  }

  async listMine(userId: string, cursor?: string, limit = 25) {
    const rows = await (
      this.prisma as any
    ).collectionCategorySuggestion.findMany({
      where: { proposedByUserId: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return {
      items: rows.slice(0, limit).map((r) => this.toResponse(r)),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async adminList(
    status?: CategorySuggestionStatus,
    cursor?: string,
    limit = 25,
  ) {
    const where: any = {};
    if (status) where.status = status;
    const rows = await (
      this.prisma as any
    ).collectionCategorySuggestion.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return {
      items: rows.slice(0, limit).map((r) => this.toResponse(r)),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async moderate(
    id: string,
    adminUserId: string,
    dto: ModerateCategorySuggestionDto,
  ) {
    const updated = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "_id" FROM "CollectionCategorySuggestion" WHERE "_id"=${id}::uuid FOR UPDATE`;
        const suggestion = await tx.collectionCategorySuggestion.findUnique({
          where: { id },
        });
        if (!suggestion) throw new NotFoundException('Suggestion not found');
        if (suggestion.status !== 'PENDING')
          throw new BadRequestException('Suggestion already decided');
        let categoryId: string | null = null;
        let categoryTypeId: string | null = null;
        let rejectionReason: string | null = null;
        if (dto.decision === ModerationDecision.REJECT) {
          rejectionReason =
            dto.rejectionReason?.trim() ||
            getBlockedTaxonomyGuidance(suggestion.name, 'category') ||
            'This suggestion does not fit the garment category taxonomy.';
        } else {
          assertGarmentCategoryTermAllowed(suggestion.name);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`category-request-slug:${suggestion.slug}`},0))`;
          const existing = await tx.collectionCategory.findUnique({
            where: { slug: suggestion.slug },
          });
          const description =
            dto.approvalDescription?.trim() ||
            suggestion.description?.trim() ||
            existing?.description?.trim();
          if (!description)
            throw new BadRequestException(
              'Add a garment category description before approval.',
            );
          const category = await tx.collectionCategory.upsert({
            where: { slug: suggestion.slug },
            create: {
              id: uuidv4(),
              slug: suggestion.slug,
              name: suggestion.name,
              description,
              isActive: true,
              order: 0,
            },
            update: {
              isActive: true,
              description: existing?.description || description,
            },
          });
          categoryId = category.id;
          if (suggestion.garmentTypeName) {
            assertGarmentSubCategoryTermAllowed(suggestion.garmentTypeName);
            const garmentType = await tx.collectionCategoryType.upsert({
              where: {
                categoryId_slug: {
                  categoryId: category.id,
                  slug: suggestion.garmentTypeSlug,
                },
              },
              create: {
                id: uuidv4(),
                categoryId: category.id,
                name: suggestion.garmentTypeName,
                slug: suggestion.garmentTypeSlug,
                description: dto.approvalGarmentTypeDescription?.trim() || null,
                isActive: true,
                order: 0,
              },
              update: { isActive: true },
            });
            categoryTypeId = garmentType.id;
          }
        }
        const decision =
          dto.decision === ModerationDecision.REJECT ? 'REJECTED' : 'APPROVED';
        const row = await tx.collectionCategorySuggestion.update({
          where: { id },
          data: {
            status: decision,
            rejectionReason,
            approvedCategoryId: categoryId,
            approvedCategoryTypeId: categoryTypeId,
            decisionByUserId: adminUserId,
            decidedAt: new Date(),
          },
        });
        await this.adminAudit?.logInTransaction(tx, {
          actorUserId: adminUserId,
          action: AdminAuditAction.ADMIN_TAXONOMY_SUGGESTION_MODERATE,
          targetType: 'CollectionCategorySuggestion',
          targetId: id,
          metadata: {
            operation: `category_suggestion_${decision.toLowerCase()}`,
          },
          previousState: {
            status: suggestion.status,
            name: suggestion.name,
            slug: suggestion.slug,
          },
          newState: {
            status: row.status,
            approvedCategoryId: categoryId,
            approvedCategoryTypeId: categoryTypeId,
            rejectionReason,
          },
        });
        return row;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    try {
      await this.collectionsService.applyCategoryDecision(id);
    } catch (error) {
      this.logger.error(
        `Category decision saved; linked content propagation will retry: ${id}`,
        error,
      );
    }
    return this.toResponse(updated);
  }
}
