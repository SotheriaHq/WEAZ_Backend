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
exports.MessagingInboxController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let MessagingInboxController = class MessagingInboxController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async inbox(req, query) {
        return this.messaging.getInboxForActor(req.user.id, query);
    }
    async resolveThread(req, threadId) {
        return this.messaging.resolveThreadForActor(req.user.id, threadId);
    }
    async listThreadMessages(req, threadId, query) {
        return this.messaging.listThreadMessagesForActor(req.user.id, threadId, query);
    }
    async sendThreadMessage(req, threadId, dto, idempotencyKey) {
        return this.messaging.sendMessageToThread(req.user.id, threadId, dto, idempotencyKey);
    }
    async markThreadRead(req, threadId, dto) {
        return this.messaging.markThreadReadById(req.user.id, threadId, dto);
    }
};
exports.MessagingInboxController = MessagingInboxController;
__decorate([
    (0, common_1.Get)('inbox'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, messaging_dto_1.QueryInboxDto]),
    __metadata("design:returntype", Promise)
], MessagingInboxController.prototype, "inbox", null);
__decorate([
    (0, common_1.Get)('threads/:threadId/resolve'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], MessagingInboxController.prototype, "resolveThread", null);
__decorate([
    (0, common_1.Get)('threads/:threadId/messages'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __param(2, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], MessagingInboxController.prototype, "listThreadMessages", null);
__decorate([
    (0, common_1.Post)('threads/:threadId/messages'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Headers)('idempotency-key')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.SendMessageDto, String]),
    __metadata("design:returntype", Promise)
], MessagingInboxController.prototype, "sendThreadMessage", null);
__decorate([
    (0, common_1.Post)('threads/:threadId/read'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.MarkThreadReadDto]),
    __metadata("design:returntype", Promise)
], MessagingInboxController.prototype, "markThreadRead", null);
exports.MessagingInboxController = MessagingInboxController = __decorate([
    (0, common_1.Controller)('messaging'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], MessagingInboxController);
//# sourceMappingURL=messaging-inbox.controller.js.map