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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingAttachmentService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../prisma/prisma.service");
const system_config_service_1 = require("../admin/system-config/system-config.service");
let MessagingAttachmentService = class MessagingAttachmentService {
    constructor(prisma, systemConfigService) {
        this.prisma = prisma;
        this.systemConfigService = systemConfigService;
    }
    async resolveValidatedAttachments(userId, attachmentFileIds) {
        const fileIds = Array.from(new Set((attachmentFileIds ?? []).filter(Boolean)));
        if (fileIds.length === 0) {
            return [];
        }
        if (fileIds.length > 5) {
            throw new common_1.BadRequestException('A maximum of 5 attachments is allowed');
        }
        const files = await this.prisma.fileUpload.findMany({
            where: { id: { in: fileIds }, userId },
            select: { id: true, fileType: true, size: true },
        });
        if (files.length !== fileIds.length) {
            throw new common_1.BadRequestException('One or more attachments are invalid or not owned by actor');
        }
        const docCount = files.filter((f) => f.fileType === client_1.FileType.MESSAGE_DOCUMENT).length;
        if (docCount > 2) {
            throw new common_1.BadRequestException('A maximum of 2 documents is allowed per message');
        }
        const imageLimit = await this.systemConfigService.getMaxFileSize('upload.maxSize.messageImage');
        const docLimit = await this.systemConfigService.getMaxFileSize('upload.maxSize.messageDocument');
        for (const file of files) {
            const limit = file.fileType === client_1.FileType.MESSAGE_DOCUMENT ? docLimit : imageLimit;
            if (file.size > limit) {
                const limitMB = (limit / (1024 * 1024));
                throw new common_1.BadRequestException(`File exceeds the ${limitMB % 1 === 0 ? limitMB : limitMB.toFixed(1)}MB limit`);
            }
        }
        return files.map((file) => ({
            fileUploadId: file.id,
            kind: this.mapKind(file.fileType),
        }));
    }
    mapKind(fileType) {
        if (fileType === client_1.FileType.MESSAGE_IMAGE)
            return client_1.MessageAttachmentKind.IMAGE;
        if (fileType === client_1.FileType.MESSAGE_DOCUMENT)
            return client_1.MessageAttachmentKind.DOCUMENT;
        throw new common_1.BadRequestException('Unsupported attachment type for messaging');
    }
};
exports.MessagingAttachmentService = MessagingAttachmentService;
exports.MessagingAttachmentService = MessagingAttachmentService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        system_config_service_1.SystemConfigService])
], MessagingAttachmentService);
//# sourceMappingURL=messaging-attachment.service.js.map