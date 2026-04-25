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
exports.CustomOrdersBuyerController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../auth/guard/user-type.guard");
const idempotency_interceptor_1 = require("../common/interceptors/idempotency.interceptor");
const custom_orders_payments_service_1 = require("./custom-orders-payments.service");
const custom_orders_service_1 = require("./custom-orders.service");
const custom_orders_dto_1 = require("./dto/custom-orders.dto");
let CustomOrdersBuyerController = class CustomOrdersBuyerController {
    constructor(ordersService, paymentsService) {
        this.ordersService = ordersService;
        this.paymentsService = paymentsService;
    }
    async pricePreview(req, dto) {
        return this.ordersService.createPricePreview(req.user.id, dto);
    }
    async createOrder(req, dto) {
        return this.ordersService.createOrder(req.user.id, dto);
    }
    async initializePayment(id, req, dto) {
        return this.paymentsService.initializePayment(req.user.id, id, dto);
    }
    async verifyPayment(id, req, dto) {
        return this.paymentsService.verifyPayment(req.user.id, id, dto);
    }
    async listOrders(req, query) {
        return this.ordersService.listBuyerOrders(req.user.id, query);
    }
    async getDisplayChartPreference(req) {
        return this.ordersService.getDisplayChartPreference(req.user.id);
    }
    async updateDisplayChartPreference(req, dto) {
        return this.ordersService.updateDisplayChartPreference(req.user.id, dto);
    }
    async getOrder(id, req) {
        return this.ordersService.getBuyerOrder(req.user.id, id);
    }
    async cancelOrder(id, req, dto) {
        return this.ordersService.cancelBuyerOrder(req.user.id, id, dto);
    }
    async confirmDelivery(id, req, dto) {
        return this.ordersService.confirmDelivery(req.user.id, id, dto);
    }
    async reportIssue(id, req, dto) {
        return this.ordersService.reportIssue(req.user.id, id, dto);
    }
    async updateMeasurements(id, req, dto) {
        return this.ordersService.updateBuyerMeasurementsBeforeAcceptance(req.user.id, id, dto);
    }
    async respondToExtension(id, requestId, req, dto) {
        return this.ordersService.respondToExtension(req.user.id, id, requestId, dto);
    }
};
exports.CustomOrdersBuyerController = CustomOrdersBuyerController;
__decorate([
    (0, common_1.Post)('price-preview'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_orders_dto_1.CustomOrderPricePreviewDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "pricePreview", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseInterceptors)(idempotency_interceptor_1.IdempotencyInterceptor),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_orders_dto_1.CreateCustomOrderDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "createOrder", null);
__decorate([
    (0, common_1.Post)(':id/payment/initialize'),
    (0, common_1.UseInterceptors)(idempotency_interceptor_1.IdempotencyInterceptor),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.InitializeCustomOrderPaymentDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "initializePayment", null);
__decorate([
    (0, common_1.Post)(':id/payment/verify'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.VerifyCustomOrderPaymentDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "verifyPayment", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_orders_dto_1.QueryCustomOrdersDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "listOrders", null);
__decorate([
    (0, common_1.Get)('preferences/display-chart'),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "getDisplayChartPreference", null);
__decorate([
    (0, common_1.Post)('preferences/display-chart'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, custom_orders_dto_1.UpdateDisplayChartPreferenceDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "updateDisplayChartPreference", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "getOrder", null);
__decorate([
    (0, common_1.Post)(':id/cancel'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.CancelCustomOrderDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "cancelOrder", null);
__decorate([
    (0, common_1.Post)(':id/confirm-delivery'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.ConfirmCustomOrderDeliveryDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "confirmDelivery", null);
__decorate([
    (0, common_1.Post)(':id/report-issue'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.ReportCustomOrderIssueDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "reportIssue", null);
__decorate([
    (0, common_1.Post)(':id/update-measurements'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, custom_orders_dto_1.UpdateCustomOrderMeasurementsDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "updateMeasurements", null);
__decorate([
    (0, common_1.Post)(':id/extension-requests/:requestId/respond'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Param)('requestId')),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, custom_orders_dto_1.RespondToCustomOrderExtensionDto]),
    __metadata("design:returntype", Promise)
], CustomOrdersBuyerController.prototype, "respondToExtension", null);
exports.CustomOrdersBuyerController = CustomOrdersBuyerController = __decorate([
    (0, common_1.Controller)('custom-orders'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.REGULAR)),
    __metadata("design:paramtypes", [custom_orders_service_1.CustomOrdersService,
        custom_orders_payments_service_1.CustomOrdersPaymentsService])
], CustomOrdersBuyerController);
//# sourceMappingURL=custom-orders-buyer.controller.js.map