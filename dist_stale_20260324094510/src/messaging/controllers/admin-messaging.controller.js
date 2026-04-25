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
exports.AdminMessagingController = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const roles_decorator_1 = require("../../auth/decorator/roles.decorator");
const jwt_auth_guard_1 = require("../../auth/guard/jwt-auth.guard");
const role_guard_1 = require("../../auth/guard/role.guard");
const permissions_1 = require("../../admin/constants/permissions");
const require_permissions_decorator_1 = require("../../admin/decorators/require-permissions.decorator");
const admin_permission_guard_1 = require("../../admin/guards/admin-permission.guard");
const messaging_service_1 = require("../messaging.service");
const messaging_dto_1 = require("../dto/messaging.dto");
let AdminMessagingController = class AdminMessagingController {
    constructor(messaging) {
        this.messaging = messaging;
    }
    async inbox(query) {
        return this.messaging.getAdminInbox(query);
    }
    async getThread(req, threadId) {
        return this.messaging.getAdminThread(req.user.id, threadId);
    }
    async getThreadMessages(req, threadId, query) {
        return this.messaging.getAdminThreadMessages(req.user.id, threadId, query);
    }
    async getCustomOrderMessages(orderId, query) {
        return this.messaging.getAdminMessagesForContext('CUSTOM_ORDER', orderId, query);
    }
    async getOrderMessages(orderId, query) {
        return this.messaging.getAdminMessagesForContext('STANDARD_ORDER', orderId, query);
    }
    async hideMessage(req, messageId, dto) {
        return this.messaging.hideMessage(req.user.id, messageId, dto.reason, req);
    }
    async redactMessage(req, messageId, dto) {
        return this.messaging.redactMessage(req.user.id, messageId, dto.reason, req);
    }
    async reopenThread(req, threadId) {
        return this.messaging.reopenThread(req.user.id, threadId, req);
    }
    async addSystemMessage(req, threadId, dto) {
        return this.messaging.addSystemMessage(req.user.id, threadId, dto, req);
    }
};
exports.AdminMessagingController = AdminMessagingController;
__decorate([
    (0, common_1.Get)('inbox'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_READ),
    __param(0, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [messaging_dto_1.QueryInboxDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "inbox", null);
__decorate([
    (0, common_1.Get)('threads/:threadId'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_READ),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "getThread", null);
__decorate([
    (0, common_1.Get)('threads/:threadId/messages'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_READ),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __param(2, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "getThreadMessages", null);
__decorate([
    (0, common_1.Get)('custom-orders/:orderId/messages'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_READ),
    __param(0, (0, common_1.Param)('orderId')),
    __param(1, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "getCustomOrderMessages", null);
__decorate([
    (0, common_1.Get)('orders/:orderId/messages'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_READ),
    __param(0, (0, common_1.Param)('orderId')),
    __param(1, (0, common_1.Query)(new common_1.ValidationPipe({ transform: true, whitelist: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, messaging_dto_1.QueryMessagesDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "getOrderMessages", null);
__decorate([
    (0, common_1.Post)('messages/:messageId/hide'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_MODERATE),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('messageId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.ModerateMessageDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "hideMessage", null);
__decorate([
    (0, common_1.Post)('messages/:messageId/redact'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_MODERATE),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('messageId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.ModerateMessageDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "redactMessage", null);
__decorate([
    (0, common_1.Post)('threads/:threadId/reopen'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_MODERATE),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "reopenThread", null);
__decorate([
    (0, common_1.Post)('threads/:threadId/system-message'),
    (0, require_permissions_decorator_1.RequirePermissions)(permissions_1.ADMIN_PERMISSIONS.MESSAGING_MODERATE),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('threadId')),
    __param(2, (0, common_1.Body)(new common_1.ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, messaging_dto_1.AdminSystemMessageDto]),
    __metadata("design:returntype", Promise)
], AdminMessagingController.prototype, "addSystemMessage", null);
exports.AdminMessagingController = AdminMessagingController = __decorate([
    (0, common_1.Controller)('admin/messaging'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, role_guard_1.RolesGuard, admin_permission_guard_1.AdminPermissionGuard),
    (0, roles_decorator_1.Roles)(client_1.Role.SuperAdmin, client_1.Role.Admin),
    __metadata("design:paramtypes", [messaging_service_1.MessagingService])
], AdminMessagingController);
//# sourceMappingURL=admin-messaging.controller.js.map