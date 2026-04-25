"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CategorySuggestionsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const moderate_category_suggestion_dto_1 = require("./dto/moderate-category-suggestion.dto");
const uuid_1 = require("uuid");
const collections_service_1 = require("../../collections/collections.service");
let CategorySuggestionsService = class CategorySuggestionsService {
    constructor(prisma, collectionsService) {
        this.prisma = prisma;
        this.collectionsService = collectionsService;
    }
    normalizeSlug(base) {
        return (base
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9 ]+/g, '')
            .replace(/\s+/g, '-')
            .slice(0, 60) || 'category');
    }
    toResponse(row) {
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
    async submit(userId, dto) {
        const name = dto.name.trim();
        if (name.length < 2 || name.length > 48) {
            throw new common_1.BadRequestException('Name length out of bounds');
        }
        const slug = this.normalizeSlug(name);
        const existingCategory = await this.prisma.collectionCategory.findUnique({
            where: { slug },
        });
        if (existingCategory) {
            throw new common_1.BadRequestException('A category with this name already exists');
        }
        const existingPending = await this.prisma.collectionCategorySuggestion.findFirst({
            where: { slug, status: 'PENDING' },
        });
        if (existingPending) {
            throw new common_1.BadRequestException('A pending suggestion with this name already exists');
        }
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentCount = await this.prisma.collectionCategorySuggestion.count({
            where: { proposedByUserId: userId, createdAt: { gte: since } },
        });
        if (recentCount >= 5) {
            throw new common_1.BadRequestException('Rate limit exceeded: please wait before submitting more suggestions');
        }
        const id = (0, uuid_1.v4)();
        const row = await this.prisma.collectionCategorySuggestion.create({
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
    async listMine(userId) {
        const rows = await this.prisma.collectionCategorySuggestion.findMany({
            where: { proposedByUserId: userId },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map((r) => this.toResponse(r));
    }
    async adminList(status) {
        const where = {};
        if (status)
            where.status = status;
        const rows = await this.prisma.collectionCategorySuggestion.findMany({
            where,
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
        return rows.map((r) => this.toResponse(r));
    }
    async moderate(id, adminUserId, dto) {
        const suggestion = await this.prisma.collectionCategorySuggestion.findUnique({ where: { id } });
        if (!suggestion)
            throw new common_1.NotFoundException('Suggestion not found');
        if (suggestion.status !== 'PENDING') {
            throw new common_1.BadRequestException('Suggestion already decided');
        }
        if (dto.decision === moderate_category_suggestion_dto_1.ModerationDecision.REJECT) {
            const updated = await this.prisma.collectionCategorySuggestion.update({
                where: { id },
                data: {
                    status: 'REJECTED',
                    rejectionReason: dto.rejectionReason?.trim() || null,
                    decisionByUserId: adminUserId,
                    decidedAt: new Date(),
                },
            });
            try {
                const rejectionResult = await this.collectionsService.handleRejectedCategory(id, dto.rejectionReason?.trim() ||
                    'Your category suggestion was not approved.');
                console.log(`Rejection handled: ${rejectionResult.updated} collections updated, ${rejectionResult.notified} users notified`);
            }
            catch (error) {
                console.error('Error handling rejected category:', error);
            }
            return this.toResponse(updated);
        }
        const slug = suggestion.slug;
        let category = await this.prisma.collectionCategory.findUnique({
            where: { slug },
        });
        if (!category) {
            category = await this.prisma.collectionCategory.create({
                data: {
                    id: (0, uuid_1.v4)(),
                    slug,
                    name: suggestion.name,
                    description: suggestion.description,
                    isActive: true,
                    order: 0,
                },
            });
        }
        const updated = await this.prisma.collectionCategorySuggestion.update({
            where: { id },
            data: {
                status: 'APPROVED',
                approvedCategoryId: category.id,
                decisionByUserId: adminUserId,
                decidedAt: new Date(),
            },
        });
        try {
            const publishResult = await this.collectionsService.autoPublishPendingCollections(id, category.id);
            console.log(`Auto-publish result: ${publishResult.published} published, ${publishResult.skipped} skipped, ${publishResult.failed} failed`);
            if (publishResult.errors.length > 0) {
                console.error('Auto-publish errors:', publishResult.errors);
            }
        }
        catch (error) {
            console.error('Error auto-publishing collections:', error);
        }
        return this.toResponse(updated);
    }
};
exports.CategorySuggestionsService = CategorySuggestionsService;
exports.CategorySuggestionsService = CategorySuggestionsService = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)((0, common_1.forwardRef)(() => collections_service_1.CollectionsService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        collections_service_1.CollectionsService])
], CategorySuggestionsService);
//# sourceMappingURL=category-suggestions.service.js.map