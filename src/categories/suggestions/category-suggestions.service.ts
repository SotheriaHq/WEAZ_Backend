import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
import { ModerateCategorySuggestionDto, ModerationDecision } from './dto/moderate-category-suggestion.dto';
import { v4 as uuidv4 } from 'uuid';
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
  constructor(private readonly prisma: PrismaService) {}

  private normalizeSlug(base: string): string {
    return base
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'category';
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

  async submit(userId: string, dto: SubmitCategorySuggestionDto) {
    const name = dto.name.trim();
    if (name.length < 2 || name.length > 48) {
      throw new BadRequestException('Name length out of bounds');
    }
    const slug = this.normalizeSlug(name);

    // Duplicate checks against existing categories
    const existingCategory = await this.prisma.collectionCategory.findUnique({ where: { slug } });
    if (existingCategory) {
      throw new BadRequestException('A category with this name already exists');
    }
    // Duplicate pending suggestion
  const existingPending = await (this.prisma as any).collectionCategorySuggestion.findFirst({ where: { slug, status: 'PENDING' } });
    if (existingPending) {
      throw new BadRequestException('A pending suggestion with this name already exists');
    }

    // Rate limiting: max 5 suggestions in last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await (this.prisma as any).collectionCategorySuggestion.count({ where: { proposedByUserId: userId, createdAt: { gte: since } } });
    if (recentCount >= 5) {
      throw new BadRequestException('Rate limit exceeded: please wait before submitting more suggestions');
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
    const rows = await (this.prisma as any).collectionCategorySuggestion.findMany({
      where: { proposedByUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toResponse(r));
  }

  async adminList(status?: CategorySuggestionStatus) {
    const where: any = {};
    if (status) where.status = status;
    const rows = await (this.prisma as any).collectionCategorySuggestion.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.toResponse(r));
  }

  async moderate(id: string, adminUserId: string, dto: ModerateCategorySuggestionDto) {
    const suggestion = await (this.prisma as any).collectionCategorySuggestion.findUnique({ where: { id } });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    if (suggestion.status !== 'PENDING') {
      throw new BadRequestException('Suggestion already decided');
    }

    if (dto.decision === ModerationDecision.REJECT) {
      const updated = await (this.prisma as any).collectionCategorySuggestion.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: dto.rejectionReason?.trim() || null,
          decisionByUserId: adminUserId,
          decidedAt: new Date(),
        },
      });
      return this.toResponse(updated);
    }

    // APPROVE
    const slug = suggestion.slug;
    let category = await this.prisma.collectionCategory.findUnique({ where: { slug } });
    if (!category) {
      // Create new category directly with same slug & name
      category = await this.prisma.collectionCategory.create({
        data: {
          id: uuidv4(),
            slug,
            name: suggestion.name,
            description: suggestion.description,
            isActive: true,
            order: 0,
        },
      });
    }

    const updated = await (this.prisma as any).collectionCategorySuggestion.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedCategoryId: category.id,
        decisionByUserId: adminUserId,
        decidedAt: new Date(),
      },
    });
    return this.toResponse(updated);
  }
}
