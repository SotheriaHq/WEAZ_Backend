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
exports.CustomOrdersBrandController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../auth/guard/user-type.guard");
const custom_orders_service_1 = require("./custom-orders.service");
const custom_orders_dto_1 = require("./dto/custom-orders.dto");
let CustomOrdersBrandController = class CustomOrdersBrandController {
    constructor(service) {
        this.service = service;
    }
    async listOrders(brandId, req, query) {
        return this.service.listBrandOrders(req.user.id, brandId, query);
    }
    async getOrder(brandId, id, req) {
        return this.service.getBrandOrder(req.user.id, brandId, id);
    }
    async acceptOrder(brandId, id, req, dto) {
        return this.service.acceptBrandOrder(req.user.id, brandId, id, dto);
    }
    async rejectOrder(brandId, id, req, dto) {
        return this.service.rejectBrandOrder(req.user.id, brandId, id, dto);
    }
    async updateProgressStage(brandId, id, req, dto) {
        return this.service.updateBrandProgressStage(req.user.id, brandId, id, dto);
    }
    async createExtensionRequest(brandId, id, req, dto) {
        return this.service.createExtensionRequest(req.user.id, brandId, id, dto);
    }
    async respondToBuyerCounter(brandId, id, requestId, req, dto) {
        return this.service.respondToBuyerCounter(req.user.id, brandId, id, requestId, dto);
    }
    async updateLifecycleStatus(brandId, id, req, dto) {
        return this.service.updateLifecycleStatus(req.user.id, brandId, id, dto);
    }
    async createExceptionReviewRequest(brandId, id, req, dto) {
        return this.service.createExceptionReviewRequest(req.user.id, brandId, id, dto);
    }
};
exports.CustomOrdersBrandController = CustomOrdersBrandController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.QueryCustomOrdersDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "listOrders", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "getOrder", null);
__decorate([
    (0, common_1.Post)(':id/accept'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.AcceptCustomOrderDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "acceptOrder", null);
__decorate([
    (0, common_1.Post)(':id/reject'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.RejectCustomOrderDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "rejectOrder", null);
__decorate([
    (0, common_1.Post)(':id/progress-stage'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.UpdateCustomOrderProgressStageDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "updateProgressStage", null);
__decorate([
    (0, common_1.Post)(':id/extension-requests'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.CreateCustomOrderExtensionRequestDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "createExtensionRequest", null);
__decorate([
    (0, common_1.Post)(':id/extension-requests/:requestId/respond'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Param)('requestId')),
    __param(3, (0, common_1.Req)()),
    __param(4, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object, custom_orders_dto_1.BrandRespondToCustomOrderExtensionCounterDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "respondToBuyerCounter", null);
__decorate([
    (0, common_1.Patch)(':id/status'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.UpdateCustomOrderLifecycleStatusDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "updateLifecycleStatus", null);
__decorate([
    (0, common_1.Post)(':id/exception-review-requests'),
    __param(0, (0, common_1.Param)('brandId')),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.CreateExceptionReviewRequestDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBrandController.prototype, "createExceptionReviewRequest", null);
exports.CustomOrdersBrandController = CustomOrdersBrandController = __decorate([
    (0, common_1.Controller)('brands/:brandId/custom-orders'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __metadata("design:paramtypes", [custom_orders_service_1.CustomOrdersService])
], CustomOrdersBrandController);
//# sourceMappingURL=custom-orders-brand.controller.js.map