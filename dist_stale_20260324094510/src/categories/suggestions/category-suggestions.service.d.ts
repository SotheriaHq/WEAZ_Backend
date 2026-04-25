import { PrismaService } from '../../prisma/prisma.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
import { ModerateCategorySuggestionDto } from './dto/moderate-category-suggestion.dto';
import { CollectionsService } from '../../collections/collections.service';
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
export declare class CategorySuggestionsService {
    private readonly prisma;
    private readonly collectionsService;
    constructor(prisma: PrismaService, collectionsService: CollectionsService);
    private normalizeSlug;
    private toResponse;
    submit(userId: string, dto: SubmitCategorySuggestionDto): Promise<SuggestionResponse>;
    listMine(userId: string): Promise<any>;
    adminList(status?: CategorySuggestionStatus): Promise<any>;
    moderate(id: string, adminUserId: string, dto: ModerateCategorySuggestionDto): Promise<SuggestionResponse>;
}
export {};
