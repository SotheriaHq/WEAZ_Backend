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
exports.CategorySuggestionsController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const category_suggestions_service_1 = require("./category-suggestions.service");
const submit_category_suggestion_dto_1 = require("./dto/submit-category-suggestion.dto");
const swagger_1 = require("@nestjs/swagger");
let CategorySuggestionsController = class CategorySuggestionsController {
    constructor(suggestions) {
        this.suggestions = suggestions;
    }
    async submit(req, dto) {
        return this.suggestions.submit(req.user.id, dto);
    }
    async mine(req) {
        return this.suggestions.listMine(req.user.id);
    }
};
exports.CategorySuggestionsController = CategorySuggestionsController;
__decorate([
    (0, common_1.Post)(),
    (0, swagger_1.ApiOperation)({ summary: 'Submit a new category suggestion' }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, submit_category_suggestion_dto_1.SubmitCategorySuggestionDto]),
    __metadata("design:returntype", Promise)
], CategorySuggestionsController.prototype, "submit", null);
__decorate([
    (0, common_1.Get)('mine'),
    (0, swagger_1.ApiOperation)({ summary: 'List suggestions submitted by current user' }),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CategorySuggestionsController.prototype, "mine", null);
exports.CategorySuggestionsController = CategorySuggestionsController = __decorate([
    (0, swagger_1.ApiTags)('category-suggestions'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('categories/suggestions'),
    __metadata("design:paramtypes", [category_suggestions_service_1.CategorySuggestionsService])
], CategorySuggestionsController);
//# sourceMappingURL=category-suggestions.controller.js.map