import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { AdminAuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
import {
  ModerateCategorySuggestionDto,
  ModerationDecision,
} from './dto/moderate-category-suggestion.dto';
import { v4 as uuidv4 } from 'uuid';
import { CollectionsService } from '../../collections/collections.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import {
  assertGarmentCategoryTermAllowed,
  getBlockedTaxonomyGuidance,
} from '../taxonomy-governance';
// Use local types to avoid build-time coupling to generated Prisma enums
export type CategorySuggestionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface SuggestionResponse {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  status: CategorySuggestionStatus;
  rejectionReason?: string | null;
  approvedCategoryId?: string | null;
  proposedByUserId: string;
  decisionByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt?: Date | null;
}

@Injectable()
export class CategorySuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CollectionsService))
    private readonly collectionsService: CollectionsService,
    @Optional() private readonly adminAudit?: AdminAuditService,
  ) {}

  private normalizeSlug(base: string): string {
    return (
      base
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]+/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'category'
    );
  }

  private toResponse(row: any): SuggestionResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      status: row.status,
      rejectionReason: row.rejectionReason,
      approvedCategoryId: row.approvedCategoryId,
      proposedByUserId: row.proposedByUserId,
      decisionByUserId: row.decisionByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      decidedAt: row.decidedAt,
    };
  }

  private async recordSuggestionAudit(params: {
    actorUserId: string;
    suggestionId: string;
    operation: 'approved' | 'rejected';
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  }) {
    await this.adminAudit?.safeLog({
      actorUserId: params.actorUserId,
      action: AdminAuditAction.ADMIN_TAXONOMY_SUGGESTION_MODERATE,
      targetType: 'CollectionCategorySuggestion',
      targetId: params.suggestionId,
      metadata: { operation: `category_suggestion_${params.operation}` },
      previousState: params.previousState,
      newState: params.newState,
    });
  }

  async submit(userId: string, dto: SubmitCategorySuggestionDto) {
    const name = dto.name.trim();
    if (name.length < 2 || name.length > 48) {
      throw new BadRequestException('Name length out of bounds');
    }
    assertGarmentCategoryTermAllowed(name);
    const slug = this.normalizeSlug(name);

    // Duplicate checks against existing categories
    const existingCategory = await this.prisma.collectionCategory.findUnique({
      where: { slug },
    });
    if (existingCategory) {
      throw new BadRequestException('A category with this name already exists');
    }
    // Duplicate pending suggestion
    const existingPending = await (
      this.prisma as any
    ).collectionCategorySuggestion.findFirst({
      where: { slug, status: 'PENDING' },
    });
    if (existingPending) {
      throw new BadRequestException(
        'A pending suggestion with this name already exists',
      );
    }

    // Rate limiting: max 5 suggestions in last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await (
      this.prisma as any
    ).collectionCategorySuggestion.count({
      where: { proposedByUserId: userId, createdAt: { gte: since } },
    });
    if (recentCount >= 5) {
      throw new BadRequestException(
        'Rate limit exceeded: please wait before submitting more suggestions',
      );
    }

    const id = uuidv4();
    const row = await (this.prisma as any).collectionCategorySuggestion.create({
      data: {
        id,
        name,
        slug,
        description: dto.description?.trim() || null,
        proposedByUserId: userId,
        status: 'PENDING',
      },
    });
    return this.toResponse(row);
  }

  async listMine(userId: string) {
    const rows = await (
      this.prisma as any
    ).collectionCategorySuggestion.findMany({
      where: { proposedByUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toResponse(r));
  }

  async adminList(status?: CategorySuggestionStatus) {
    const where: any = {};
    if (status) where.status = status;
    const rows = await (
      this.prisma as any
    ).collectionCategorySuggestion.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toResponse(r));
  }

  async moderate(
    id: string,
    adminUserId: string,
    dto: ModerateCategorySuggestionDto,
  ) {
    const suggestion = await (
      this.prisma as any
    ).collectionCategorySuggestion.findUnique({ where: { id } });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    if (suggestion.status !== 'PENDING') {
      throw new BadRequestException('Suggestion already decided');
    }

    if (dto.decision === ModerationDecision.REJECT) {
      const blockedGuidance = getBlockedTaxonomyGuidance(
        suggestion.name,
        'category',
      );
      const rejectionReason =
        dto.rejectionReason?.trim() ||
        blockedGuidance ||
        'This suggestion does not fit the garment category taxonomy.';
      const updated = await (
        this.prisma as any
      ).collectionCategorySuggestion.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason,
          decisionByUserId: adminUserId,
          decidedAt: new Date(),
        },
      });
      await this.recordSuggestionAudit({
        actorUserId: adminUserId,
        suggestionId: id,
        operation: 'rejected',
        previousState: {
          status: suggestion.status,
          name: suggestion.name,
          slug: suggestion.slug,
        },
        newState: {
          status: updated.status,
          rejectionReason: updated.rejectionReason,
        },
      });

      // PHASE 2: Handle rejection - update linked collections
      try {
        const rejectionResult =
          await this.collectionsService.handleRejectedCategory(
            id,
            rejectionReason,
          );
        console.log(
          `Rejection handled: ${rejectionResult.updated} collections updated, ${rejectionResult.notified} users notified`,
        );
      } catch (error) {
        console.error('Error handling rejected category:', error);
        // Don't fail the rejection if notification fails
      }

      return this.toResponse(updated);
    }

    // APPROVE
    assertGarmentCategoryTermAllowed(suggestion.name);
    const slug = suggestion.slug;
    let category = await this.prisma.collectionCategory.findUnique({
      where: { slug },
    });
    const approvedDescription =
      dto.approvalDescription?.trim() ||
      suggestion.description?.trim() ||
      category?.description?.trim() ||
      null;
    if (!approvedDescription) {
      throw new BadRequestException(
        'Add a garment category description before approval.',
      );
    }
    if (!category) {
      // Create new category directly with same slug & name
      category = await this.prisma.collectionCategory.create({
        data: {
          id: uuidv4(),
          slug,
          name: suggestion.name,
          description: approvedDescription,
          isActive: true,
          order: 0,
        },
      });
    } else if (!category.isActive || !category.description) {
      category = await this.prisma.collectionCategory.update({
        where: { id: category.id },
        data: {
          isActive: true,
          description: category.description || approvedDescription,
        },
      });
    }

    const updated = await (
      this.prisma as any
    ).collectionCategorySuggestion.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedCategoryId: category.id,
        decisionByUserId: adminUserId,
        decidedAt: new Date(),
      },
    });
    await this.recordSuggestionAudit({
      actorUserId: adminUserId,
      suggestionId: id,
      operation: 'approved',
      previousState: {
        status: suggestion.status,
        name: suggestion.name,
        slug: suggestion.slug,
      },
      newState: {
        status: updated.status,
        approvedCategoryId: category.id,
      },
    });

    // PHASE 2: Auto-publish collections waiting for this category
    try {
      const publishResult =
        await this.collectionsService.autoPublishPendingCollections(
          id,
          category.id,
        );
      console.log(
        `Auto-publish result: ${publishResult.published} published, ${publishResult.skipped} skipped, ${publishResult.failed} failed`,
      );
      if (publishResult.errors.length > 0) {
        console.error('Auto-publish errors:', publishResult.errors);
      }
    } catch (error) {
      console.error('Error auto-publishing collections:', error);
      // Don't fail the approval if auto-publish fails
    }

    return this.toResponse(updated);
  }
}
