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
exports.OrderMessagingBuyerController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const throttler_1 = require("@nestjs/throttler");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../../auth/guard/user-type.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let OrderMessagingBuyerController = class OrderMessagingBuyerController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async listMessages(req, orderId, query) {
        return this.messaging.listOrderMessagesForBuyer(req.user.id, orderId, query);
    }
    async sendMessage(req, orderId, idempotencyKey, legacyIdempotencyKey, dto) {
        return this.messaging.sendOrderMessageForBuyer(req.user.id, orderId, dto, idempotencyKey ?? legacyIdempotencyKey);
    }
    async markRead(req, orderId, dto) {
        return this.messaging.markThreadReadForContext(req.user.id, 'STANDARD_ORDER', orderId, 'BUYER', dto);
    }
    async updatePreferences(req, orderId, dto) {
        return this.messaging.updateThreadPreferencesForContext(req.user.id, 'STANDARD_ORDER', orderId, 'BUYER', dto);
    }
    async summary(req, orderId, query) {
        return this.messaging.getSummaryForContext(req.user.id, 'STANDARD_ORDER', orderId, 'BUYER', query);
    }
    async respondToExtension(req, orderId, requestMessageId, dto) {
        return this.messaging.respondToOrderExtensionForBuyer(req.user.id, orderId, requestMessageId, dto);
    }
    async openDispute(req, orderId, dto) {
        return this.messaging.openOrderDisputeForBuyer(req.user.id, orderId, dto);
    }
};
exports.OrderMessagingBuyerController = OrderMessagingBuyerController;
__decorate([
    (0, common_1.Get)(['orders/:orderId/messages', 'store/orders/:orderId/messages']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "listMessages", null);
__decorate([
    (0, common_1.Post)(['orders/:orderId/messages', 'store/orders/:orderId/messages']),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: 60000 } }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Headers)('idempotency-key')),
    __param(3, (0, common_1.Headers)('x-idempotency-key')),
    __param(4, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, messaging_dto_1.SendMessageDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "sendMessage", null);
__decorate([
    (0, common_1.Post)(['orders/:orderId/messages/read', 'store/orders/:orderId/messages/read']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.MarkThreadReadDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "markRead", null);
__decorate([
    (0, common_1.Post)(['orders/:orderId/messages/preferences', 'store/orders/:orderId/messages/preferences']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.UpdateThreadPreferencesDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "updatePreferences", null);
__decorate([
    (0, common_1.Get)(['orders/:orderId/messages/summary', 'store/orders/:orderId/messages/summary']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.QueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "summary", null);
__decorate([
    (0, common_1.Post)(['orders/:orderId/messages/extension-requests/:requestMessageId/respond', 'store/orders/:orderId/messages/extension-requests/:requestMessageId/respond']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Param)('requestMessageId')),
    __param(3, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, messaging_dto_1.RespondOrderExtensionDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "respondToExtension", null);
__decorate([
    (0, common_1.Post)(['orders/:orderId/messages/disputes', 'store/orders/:orderId/messages/disputes']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('orderId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.OpenOrderDisputeDto]),
    __metadata("design:returntype", Promise)
], OrderMessagingBuyerController.prototype, "openDispute", null);
exports.OrderMessagingBuyerController = OrderMessagingBuyerController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.REGULAR)),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], OrderMessagingBuyerController);
//# sourceMappingURL=order-messaging-buyer.controller.js.map