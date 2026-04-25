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
exports.CustomOrderConfigurationsController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../auth/guard/jwt-auth.guard");
const optional_jwt_auth_guard_1 = require("../auth/guard/optional-jwt-auth.guard");
const user_type_guard_1 = require("../auth/guard/user-type.guard");
const custom_order_configurations_service_1 = require("./custom-order-configurations.service");
const custom_order_configurations_dto_1 = require("./dto/custom-order-configurations.dto");
const client_2 = require("@prisma/client");
let CustomOrderConfigurationsController = class CustomOrderConfigurationsController {
    constructor(service) {
        this.service = service;
    }
    async getActiveProductConfiguration(productId, req) {
        return this.service.getActiveConfigurationForSource(client_2.CustomOrderSourceType.PRODUCT, productId, req.user?.id);
    }
    async getActiveDesignConfiguration(designId, req) {
        return this.service.getActiveConfigurationForSource(client_2.CustomOrderSourceType.DESIGN, designId, req.user?.id);
    }
    async listVisibleConfigurations(req, query) {
        return this.service.listVisibleConfigurations(req.user?.id, query);
    }
    async createConfiguration(req, dto) {
        return this.service.createConfiguration(req.user.id, dto);
    }
    async updateConfiguration(id, req, dto) {
        return this.service.updateConfiguration(req.user.id, id, dto);
    }
    async getConfiguration(id, req) {
        return this.service.getConfiguration(id, req.user?.id);
    }
    async createBasis(req, dto) {
        return this.service.createBasis(req.user.id, dto);
    }
    async listBases(req, query) {
        return this.service.listBases(req.user?.id, query);
    }
};
exports.CustomOrderConfigurationsController = CustomOrderConfigurationsController;
__decorate([
    (0, common_1.Get)('products/:productId/custom-order-configuration'),
    (0, common_1.UseGuards)(optional_jwt_auth_guard_1.OptionalJwtAuthGuard),
    __param(0, (0, common_1.Param)('productId')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "getActiveProductConfiguration", null);
__decorate([
    (0, common_1.Get)('designs/:designId/custom-order-configuration'),
    (0, common_1.UseGuards)(optional_jwt_auth_guard_1.OptionalJwtAuthGuard),
    __param(0, (0, common_1.Param)('designId')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "getActiveDesignConfiguration", null);
__decorate([
    (0, common_1.Get)('custom-order-configurations'),
    (0, common_1.UseGuards)(optional_jwt_auth_guard_1.OptionalJwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_configurations_dto_1.QueryVisibleCustomOrderConfigurationsDto]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "listVisibleConfigurations", null);
__decorate([
    (0, common_1.Post)('custom-order-configurations'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_configurations_dto_1.CreateCustomOrderConfigurationDto]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "createConfiguration", null);
__decorate([
    (0, common_1.Patch)('custom-order-configurations/:id'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_order_configurations_dto_1.UpdateCustomOrderConfigurationDto]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "updateConfiguration", null);
__decorate([
    (0, common_1.Get)('custom-order-configurations/:id'),
    (0, common_1.UseGuards)(optional_jwt_auth_guard_1.OptionalJwtAuthGuard),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "getConfiguration", null);
__decorate([
    (0, common_1.Post)('custom-fabric-rule-bases'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_configurations_dto_1.CreateCustomFabricRuleBasisDto]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "createBasis", null);
__decorate([
    (0, common_1.Get)('custom-fabric-rule-bases'),
    (0, common_1.UseGuards)(optional_jwt_auth_guard_1.OptionalJwtAuthGuard),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_order_configurations_dto_1.QueryCustomFabricRuleBasesDto]),
    __metadata("design:returntype", Promise)
], CustomOrderConfigurationsController.prototype, "listBases", null);
exports.CustomOrderConfigurationsController = CustomOrderConfigurationsController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [custom_order_configurations_service_1.CustomOrderConfigurationsService])
], CustomOrderConfigurationsController);
//# sourceMappingURL=custom-order-configurations.controller.js.map