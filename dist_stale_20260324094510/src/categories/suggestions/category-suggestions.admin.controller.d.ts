import { CategorySuggestionsService, CategorySuggestionStatus } from './category-suggestions.service';
import { ModerateCategorySuggestionDto } from './dto/moderate-category-suggestion.dto';
export declare class CategorySuggestionsAdminController {
    private readonly suggestions;
    constructor(suggestions: CategorySuggestionsService);
    list(status?: CategorySuggestionStatus): Promise<any>;
    moderate(id: string, dto: ModerateCategorySuggestionDto, req: any): Promise<any>;
}
