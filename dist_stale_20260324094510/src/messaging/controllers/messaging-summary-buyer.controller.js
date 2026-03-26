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
exports.MessagingSummaryBuyerController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const user_type_guard_1 = require("../../auth/guard/user-type.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let MessagingSummaryBuyerController = class MessagingSummaryBuyerController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async customOrderSummaries(req, dto) {
        return this.messaging.getBulkSummariesForCustomOrdersBuyer(req.user.id, dto);
    }
    async orderSummaries(req, dto) {
        return this.messaging.getBulkSummariesForOrdersBuyer(req.user.id, dto);
    }
};
exports.MessagingSummaryBuyerController = MessagingSummaryBuyerController;
__decorate([
    (0, common_1.Post)('custom-orders/messages/summaries'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, messaging_dto_1.BulkQueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], MessagingSummaryBuyerController.prototype, "customOrderSummaries", null);
__decorate([
    (0, common_1.Post)(['orders/messages/summaries', 'store/orders/messages/summaries']),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, messaging_dto_1.BulkQueryThreadSummaryDto]),
    __metadata("design:returntype", Promise)
], MessagingSummaryBuyerController.prototype, "orderSummaries", null);
exports.MessagingSummaryBuyerController = MessagingSummaryBuyerController = __decorate([
    (0, common_1.Controller)(),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, new user_type_guard_1.UserTypeGuard(client_1.UserType.REGULAR)),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], MessagingSummaryBuyerController);
//# sourceMappingURL=messaging-summary-buyer.controller.js.map