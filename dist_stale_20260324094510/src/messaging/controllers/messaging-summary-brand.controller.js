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
exports.MessagingSummaryBrandController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../../auth/guard/user-type.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let MessagingSummaryBrandController = class MessagingSummaryBrandController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async customOrderSummaries(req, brandId, dto) {
        return this.messaging.getBulkSummariesForCustomOrdersBrand(req.user.id, brandId, dto);
    }
    async orderSummaries(req, brandId, dto) {
        return this.messaging.getBulkSummariesForOrdersBrand(req.user.id, brandId, dto);
    }
};
exports.MessagingSummaryBrandController = MessagingSummaryBrandController;
__decorate([
    (0, common_1.Post)('brands/:brandId/custom-orders/messages/summaries'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.BulkQueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], MessagingSummaryBrandController.prototype, "customOrderSummaries", null);
__decorate([
    (0, common_1.Post)('brands/:brandId/orders/messages/summaries'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.BulkQueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], MessagingSummaryBrandController.prototype, "orderSummaries", null);
exports.MessagingSummaryBrandController = MessagingSummaryBrandController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], MessagingSummaryBrandController);
//# sourceMappingURL=messaging-summary-brand.controller.js.map