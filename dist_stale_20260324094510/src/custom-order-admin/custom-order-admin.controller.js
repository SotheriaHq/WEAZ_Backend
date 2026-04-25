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
exports.CustomOrderAdminController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const roles_decorator_1 = require("../auth/decorator/roles.decorator");
const jwt_auth_guard_1 = require("../auth/guard/jwt-auth.guard");
const role_guard_1 = require("../auth/guard/role.guard");
const admin_permission_guard_1 = require("../admin/guards/admin-permission.guard");
const require_permissions_decorator_1 = require("../admin/decorators/require-permissions.decorator");
const permissions_1 = require("../admin/constants/permissions");
const custom_order_admin_service_1 = require("./custom-order-admin.service");
const custom_order_admin_dto_1 = require("./dto/custom-order-admin.dto");
let CustomOrderAdminController = class CustomOrderAdminController {
    constructor(service) {
        this.service = service;
    }
    async getPendingBases() {
        return this.service.getPendingBases();
    }
    async reviewBasis(id, req, dto) {
        return this.service.reviewBasis(id, dto, req.user.id);
    }
    async listBases(query) {
        return this.service.listBases(query);
    }
    async createBasis(req, dto) {
        return this.service.createBasis(dto, req.user.id);
    }
    async updateBasis(id, dto) {
        return this.service.updateBasis(id, dto);
    }
    async deleteBasis(id) {
        return this.service.deleteBasis(id);
    }
    async getSummary() {
        return this.service.getSummary();
    }
    async getRiskDashboard(query) {
        return this.service.getRiskDashboard(query);
    }
    async listRefundReviews(query) {
        return this.service.listRefundReviews(query);
    }
    async getRefundReview(id) {
        return this.service.getRefundReview(id);
    }
    async getStaleOrders(query) {
        return this.service.getStaleOrders(query);
    }
    async listOrders(query) {
        return this.service.listOrders(query);
    }
    async listExceptionReviews(query) {
        return this.service.listExceptionReviews(query);
    }
    async decideExceptionReview(id, eventId, req, dto) {
        return this.service.decideExceptionReview(id, eventId, dto, req.user.id);
    }
    async getOrder(id) {
        return this.service.getOrder(id);
    }
    async remindBrand(id, req, dto) {
        return this.service.remindBrand(id, dto, req.user.id);
    }
    async flagRisk(id, req, dto) {
        return this.service.flagRisk(id, dto, req.user.id);
    }
    async escalateRefundReview(id, req, dto) {
        return this.service.escalateRefundReview(id, dto, req.user.id);
    }
    async cancelPaidOrder(id, req, dto) {
        return this.service.cancelPaidOrder(id, dto, req.user.id);
    }
    async listDisputes(query) {
        return this.service.listDisputes(query);
    }
    async listLedgerAllocations(query) {
        return this.service.listLedgerAllocations(query);
    }
    async releaseLedgerAllocations(req, dto) {
        return this.service.releaseEligibleLedgerAllocations(dto, req.user.id);
    }
    async updateDispute(id, req, dto) {
        return this.service.updateDispute(id, dto, req.user.id);
    }
    async updateRetentionHold(id, req, dto) {
        return this.service.updateRetentionHold(id, dto, req.user.id);
    }
};
exports.CustomOrderAdminController = CustomOrderAdminController;
__decorate([
    (0, common_1.Get)('custom-fabric-rule-bases/pending'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MEASUREMENTS_REVIEW),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getPendingBases", null);
__decorate([
    (0, common_1.Patch)('custom-fabric-rule-bases/:id/review'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MEASUREMENTS_REVIEW),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.ReviewCustomFabricRuleBasisDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "reviewBasis", null);
__decorate([
    (0, common_1.Get)('custom-fabric-rule-bases'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.TAXONOMY_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryAdminCustomFabricRuleBasesDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listBases", null);
__decorate([
    (0, common_1.Post)('custom-fabric-rule-bases'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.TAXONOMY_WRITE),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_admin_dto_1.CreateAdminCustomFabricRuleBasisDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "createBasis", null);
__decorate([
    (0, common_1.Patch)('custom-fabric-rule-bases/:id'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.TAXONOMY_WRITE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, custom_order_admin_dto_1.UpdateAdminCustomFabricRuleBasisDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "updateBasis", null);
__decorate([
    (0, common_1.Delete)('custom-fabric-rule-bases/:id'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.TAXONOMY_WRITE),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "deleteBasis", null);
__decorate([
    (0, common_1.Get)('custom-orders/summary'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getSummary", null);
__decorate([
    (0, common_1.Get)('custom-orders/risk-dashboard'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryCustomOrderRiskDashboardDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getRiskDashboard", null);
__decorate([
    (0, common_1.Get)('custom-orders/refund-reviews'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryCustomOrderRefundReviewsDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listRefundReviews", null);
__decorate([
    (0, common_1.Get)('custom-orders/refund-reviews/:id'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_READ),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getRefundReview", null);
__decorate([
    (0, common_1.Get)('custom-orders/stale'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryStaleCustomOrdersDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getStaleOrders", null);
__decorate([
    (0, common_1.Get)('custom-orders'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryAdminCustomOrdersDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listOrders", null);
__decorate([
    (0, common_1.Get)('custom-orders/exception-reviews'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryCustomOrderExceptionReviewsDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listExceptionReviews", null);
__decorate([
    (0, common_1.Post)('custom-orders/:id/exception-reviews/:eventId/decide'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_WRITE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Param)('eventId')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_order_admin_dto_1.DecideCustomOrderExceptionReviewDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "decideExceptionReview", null);
__decorate([
    (0, common_1.Get)('custom-orders/:id'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_READ),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "getOrder", null);
__decorate([
    (0, common_1.Post)('custom-orders/:id/remind-brand'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_WRITE, permissions_1.ADMIN_PERMISSIONS.NOTIFICATIONS_SEND),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.AdminCustomOrderReminderDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "remindBrand", null);
__decorate([
    (0, common_1.Post)('custom-orders/:id/flag-risk'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MODERATION_WRITE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.FlagCustomOrderRiskDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "flagRisk", null);
__decorate([
    (0, common_1.Post)('custom-orders/:id/escalate-refund-review'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_RESOLVE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.EscalateCustomOrderRefundReviewDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "escalateRefundReview", null);
__decorate([
    (0, common_1.Post)('custom-orders/:id/cancel'),
    (0, roles_decorator_1.Roles)(client_1.Role.SuperAdmin),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_RESOLVE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.CancelPaidCustomOrderDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "cancelPaidOrder", null);
__decorate([
    (0, common_1.Get)('custom-order-disputes'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryCustomOrderDisputesDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listDisputes", null);
__decorate([
    (0, common_1.Get)('custom-order-ledger-allocations'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.PAYOUTS_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [custom_order_admin_dto_1.QueryCustomOrderLedgerAllocationsDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "listLedgerAllocations", null);
__decorate([
    (0, common_1.Post)('custom-order-ledger-allocations/release'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.PAYOUTS_PROCESS),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_admin_dto_1.ReleaseCustomOrderLedgerAllocationsDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "releaseLedgerAllocations", null);
__decorate([
    (0, common_1.Patch)('custom-order-disputes/:id'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.DISPUTES_RESOLVE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.UpdateCustomOrderDisputeDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "updateDispute", null);
__decorate([
    (0, common_1.Patch)('custom-orders/:id/retention-hold'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.SYSTEM_DATA_RETENTION_WRITE),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_admin_dto_1.UpdateCustomOrderRetentionHoldDto]),
    __metadata("design:returntype", Promise)
], CustomOrderAdminController.prototype, "updateRetentionHold", null);
exports.CustomOrderAdminController = CustomOrderAdminController = __decorate([
    (0, common_1.Controller)('admin'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, role_guard_1.RolesGuard, admin_permission_guard_1.AdminPermissionGuard),
    (0, roles_decorator_1.Roles)(client_1.Role.SuperAdmin, client_1.Role.Admin),
    __metadata("design:paramtypes", [custom_order_admin_service_1.CustomOrderAdminService])
], CustomOrderAdminController);
//# sourceMappingURL=custom-order-admin.controller.js.map