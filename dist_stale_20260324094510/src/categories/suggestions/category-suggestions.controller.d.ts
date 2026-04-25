import { CategorySuggestionsService } from './category-suggestions.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
export declare class CategorySuggestionsController {
    private readonly suggestions;
    constructor(suggestions: CategorySuggestionsService);
    submit(req: any, dto: SubmitCategorySuggestionDto): Promise<any>;
    mine(req: any): Promise<any>;
}
