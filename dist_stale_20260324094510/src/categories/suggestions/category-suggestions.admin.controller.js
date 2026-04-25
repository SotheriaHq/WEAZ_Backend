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
exports.CategorySuggestionsAdminController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const role_guard_1 = require("../../auth/guard/role.guard");
const common_2 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const category_suggestions_service_1 = require("./category-suggestions.service");
const moderate_category_suggestion_dto_1 = require("./dto/moderate-category-suggestion.dto");
const client_1 = require("@prisma/client");
const common_3 = require("@nestjs/common");
const Roles = (...roles) => (0, common_2.SetMetadata)('roles', roles);
let CategorySuggestionsAdminController = class CategorySuggestionsAdminController {
    constructor(suggestions) {
        this.suggestions = suggestions;
    }
    async list(status) {
        return this.suggestions.adminList(status);
    }
    async moderate(id, dto, req) {
        return this.suggestions.moderate(id, req.user.id, dto);
    }
};
exports.CategorySuggestionsAdminController = CategorySuggestionsAdminController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({
        summary: 'List category suggestions (filter by status optional)',
    }),
    __param(0, (0, common_1.Query)('status')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CategorySuggestionsAdminController.prototype, "list", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Moderate a suggestion (approve or reject)' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_3.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, moderate_category_suggestion_dto_1.ModerateCategorySuggestionDto, Object]),
    __metadata("design:returntype", Promise)
], CategorySuggestionsAdminController.prototype, "moderate", null);
exports.CategorySuggestionsAdminController = CategorySuggestionsAdminController = __decorate([
    (0, swagger_1.ApiTags)('admin-category-suggestions'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, role_guard_1.RolesGuard),
    Roles(client_1.Role.SuperAdmin),
    (0, common_1.Controller)('admin/categories/suggestions'),
    __metadata("design:paramtypes", [category_suggestions_service_1.CategorySuggestionsService])
], CategorySuggestionsAdminController);
//# sourceMappingURL=category-suggestions.admin.controller.js.map