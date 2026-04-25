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
var ProfileService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let ProfileService = ProfileService_1 = class ProfileService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(ProfileService_1.name);
    }
    async getProfile(userId, requestingUser) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: this.getProfileSelect(userId, requestingUser),
            });
            if (!user) {
                throw new common_1.NotFoundException('User not found');
            }
            return user;
        }
        catch (error) {
            this.logger.error('Get profile error:', error.message, error.stack);
            throw error instanceof common_1.NotFoundException
                ? error
                : new common_1.UnauthorizedException(`Failed to get profile: ${error.message}`);
        }
    }
    getProfileSelect(userId, requestingUser) {
        const isSelf = userId === requestingUser.id;
        const isAdmin = requestingUser.role === client_1.Role.Admin ||
            requestingUser.role === client_1.Role.SuperAdmin;
        const baseFields = {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneNumber: true,
            address: true,
            role: true,
            type: true,
            createdAt: true,
            updatedAt: true,
        };
        const brandFields = {
            brandFullName: true,
            cacNumber: isSelf || isAdmin,
            tin: isSelf || isAdmin,
            ceoNin: isSelf || isAdmin,
            ceoFirstName: true,
            ceoLastName: true,
            companyLocation: true,
            industriNumber: isSelf || isAdmin,
        };
        return {
            ...baseFields,
            ...(userId ? brandFields : {}),
        };
    }
};
exports.ProfileService = ProfileService;
exports.ProfileService = ProfileService = ProfileService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProfileService);
//# sourceMappingURL=profile.service.js.map