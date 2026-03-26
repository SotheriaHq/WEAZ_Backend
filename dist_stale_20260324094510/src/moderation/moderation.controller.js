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
exports.ModerationController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const prisma_service_1 = require("../prisma/prisma.service");
const client_1 = require("@prisma/client");
const jwt_auth_guard_1 = require("../auth/guard/jwt-auth.guard");
const role_guard_1 = require("../auth/guard/role.guard");
const roles_decorator_1 = require("../auth/decorator/roles.decorator");
let ModerationController = class ModerationController {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async quarantineThreads(body) {
        await this.prisma.quarantinedThread.create({
            data: {
                userId: body.userId,
                contentId: body.contentId,
                contentType: body.contentType,
                reason: body.reason ?? null,
            },
        });
        return { success: true };
    }
    async bulkRemoveThreads(body) {
        for (const e of body.entries ?? []) {
            if (e.contentType === 'COLLECTION') {
                await this.prisma.collectionReaction.deleteMany({
                    where: { userId: e.userId, collectionId: e.contentId },
                });
            }
            else if (e.contentType === 'POST') {
                await this.prisma.thread.deleteMany({
                    where: { userId: e.userId, postId: e.contentId },
                });
            }
        }
        return { success: true, removed: body.entries?.length ?? 0 };
    }
};
exports.ModerationController = ModerationController;
__decorate([
    (0, common_1.Post)('threads/quarantine'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ModerationController.prototype, "quarantineThreads", null);
__decorate([
    (0, common_1.Post)('threads/bulk-remove'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ModerationController.prototype, "bulkRemoveThreads", null);
exports.ModerationController = ModerationController = __decorate([
    (0, swagger_1.ApiTags)('moderation'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)('moderation'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, role_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)(client_1.Role.SuperAdmin, client_1.Role.Admin),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ModerationController);
//# sourceMappingURL=moderation.controller.js.map