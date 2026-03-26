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
exports.CustomOrderMessagingBrandController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const throttler_1 = require("@nestjs/throttler");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../../auth/guard/user-type.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let CustomOrderMessagingBrandController = class CustomOrderMessagingBrandController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async listMessages(req, brandId, orderId, query) {
        return this.messaging.listCustomOrderMessagesForBrand(req.user.id, brandId, orderId, query);
    }
    async sendMessage(req, brandId, orderId, idempotencyKey, legacyIdempotencyKey, dto) {
        return this.messaging.sendCustomOrderMessageForBrand(req.user.id, brandId, orderId, dto, idempotencyKey ?? legacyIdempotencyKey);
    }
    async markRead(req, brandId, orderId, dto) {
        return this.messaging.markThreadReadForContext(req.user.id, 'CUSTOM_ORDER', orderId, 'BRAND_OWNER', dto, brandId);
    }
    async updatePreferences(req, brandId, orderId, dto) {
        return this.messaging.updateThreadPreferencesForContext(req.user.id, 'CUSTOM_ORDER', orderId, 'BRAND_OWNER', dto, brandId);
    }
    async summary(req, brandId, orderId, query) {
        return this.messaging.getSummaryForContext(req.user.id, 'CUSTOM_ORDER', orderId, 'BRAND_OWNER', query, brandId);
    }
    async requestExtension(req, brandId, orderId, dto) {
        return this.messaging.requestCustomOrderExtensionForBrand(req.user.id, brandId, orderId, dto);
    }
    async openDispute(req, brandId, orderId, dto) {
        return this.messaging.openCustomOrderDisputeForBrand(req.user.id, brandId, orderId, dto);
    }
};
exports.CustomOrderMessagingBrandController = CustomOrderMessagingBrandController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "listMessages", null);
__decorate([
    (0, common_1.Post)(),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60000 } }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Headers)('idempotency-key')),
    __param(4, (0, common_1.Headers)('x-idempotency-key')),
    __param(5, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, String, messaging_dto_1.SendMessageDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "sendMessage", null);
__decorate([
    (0, common_1.Post)('read'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.MarkThreadReadDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "markRead", null);
__decorate([
    (0, common_1.Post)('preferences'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.UpdateThreadPreferencesDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "updatePreferences", null);
__decorate([
    (0, common_1.Get)('summary'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.QueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "summary", null);
__decorate([
    (0, common_1.Post)('extension-requests'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.RequestCustomOrderExtensionDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "requestExtension", null);
__decorate([
    (0, common_1.Post)('disputes'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('brandId')),
    __param(2, (0, common_1.Param)('orderId')),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.OpenCustomOrderDisputeDto]),
    __metadata("design:returntype", Promise)
], CustomOrderMessagingBrandController.prototype, "openDispute", null);
exports.CustomOrderMessagingBrandController = CustomOrderMessagingBrandController = __decorate([
    (0, common_1.Controller)('brands/:brandId/custom-orders/:orderId/messages'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.BRAND)),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], CustomOrderMessagingBrandController);
//# sourceMappingURL=custom-order-messaging-brand.controller.js.map