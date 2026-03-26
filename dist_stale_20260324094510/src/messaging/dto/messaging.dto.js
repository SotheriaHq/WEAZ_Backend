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
exports.OpenCustomOrderDisputeDto = exports.RespondCustomOrderExtensionDto = exports.RequestCustomOrderExtensionDto = exports.OpenOrderDisputeDto = exports.RespondOrderExtensionDto = exports.RequestOrderExtensionDto = exports.BulkQueryThreadSummaryDto = exports.QueryThreadSummaryDto = exports.AdminSystemMessageDto = exports.ModerateMessageDto = exports.UpdateThreadPreferencesDto = exports.MarkThreadReadDto = exports.SendMessageDto = exports.QueryInboxDto = exports.QueryMessagesDto = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
class QueryMessagesDto {
}
exports.QueryMessagesDto = QueryMessagesDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], QueryMessagesDto.prototype, "cursorCreatedAt", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((value) => Boolean(value.cursorCreatedAt)),
    (0, class_validator_1.IsUUID)('4'),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], QueryMessagesDto.prototype, "cursorId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryMessagesDto.prototype, "limit", void 0);
class QueryInboxDto {
}
exports.QueryInboxDto = QueryInboxDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], QueryInboxDto.prototype, "cursorLastMessageAt", void 0);
__decorate([
    (0, class_validator_1.ValidateIf)((value) => Boolean(value.cursorLastMessageAt)),
    (0, class_validator_1.IsUUID)('4'),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], QueryInboxDto.prototype, "cursorThreadId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryInboxDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['all', 'unread', 'archived']),
    __metadata("design:type", String)
], QueryInboxDto.prototype, "filter", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['all', 'STANDARD_ORDER', 'CUSTOM_ORDER', 'INQUIRY']),
    __metadata("design:type", String)
], QueryInboxDto.prototype, "contextType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], QueryInboxDto.prototype, "q", void 0);
class SendMessageDto {
}
exports.SendMessageDto = SendMessageDto;
__decorate([
    (0, class_validator_1.IsUUID)('4'),
    __metadata("design:type", String)
], SendMessageDto.prototype, "clientMessageId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(4000),
    __metadata("design:type", String)
], SendMessageDto.prototype, "bodyText", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayUnique)(),
    (0, class_validator_1.ArrayMaxSize)(5),
    (0, class_validator_1.IsUUID)('4', { each: true }),
    __metadata("design:type", Array)
], SendMessageDto.prototype, "attachmentFileIds", void 0);
class MarkThreadReadDto {
}
exports.MarkThreadReadDto = MarkThreadReadDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)('4'),
    __metadata("design:type", String)
], MarkThreadReadDto.prototype, "upToMessageId", void 0);
class UpdateThreadPreferencesDto {
}
exports.UpdateThreadPreferencesDto = UpdateThreadPreferencesDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateThreadPreferencesDto.prototype, "archived", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateThreadPreferencesDto.prototype, "markRead", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(24 * 30),
    __metadata("design:type", Number)
], UpdateThreadPreferencesDto.prototype, "muteForHours", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateThreadPreferencesDto.prototype, "unmute", void 0);
class ModerateMessageDto {
}
exports.ModerateMessageDto = ModerateMessageDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], ModerateMessageDto.prototype, "reason", void 0);
class AdminSystemMessageDto {
}
exports.AdminSystemMessageDto = AdminSystemMessageDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], AdminSystemMessageDto.prototype, "bodyText", void 0);
class QueryThreadSummaryDto {
}
exports.QueryThreadSummaryDto = QueryThreadSummaryDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['true', 'false']),
    __metadata("design:type", String)
], QueryThreadSummaryDto.prototype, "includeUnreadCount", void 0);
class BulkQueryThreadSummaryDto {
}
exports.BulkQueryThreadSummaryDto = BulkQueryThreadSummaryDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayUnique)(),
    (0, class_validator_1.ArrayMaxSize)(100),
    (0, class_validator_1.MinLength)(1, { each: true }),
    (0, class_validator_1.IsUUID)('4', { each: true }),
    __metadata("design:type", Array)
], BulkQueryThreadSummaryDto.prototype, "contextIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['true', 'false']),
    __metadata("design:type", String)
], BulkQueryThreadSummaryDto.prototype, "includeUnreadCount", void 0);
class RequestOrderExtensionDto {
}
exports.RequestOrderExtensionDto = RequestOrderExtensionDto;
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(5),
    __metadata("design:type", Number)
], RequestOrderExtensionDto.prototype, "requestedExtraDays", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], RequestOrderExtensionDto.prototype, "reason", void 0);
class RespondOrderExtensionDto {
}
exports.RespondOrderExtensionDto = RespondOrderExtensionDto;
__decorate([
    (0, class_validator_1.IsIn)(['ACCEPTED', 'REJECTED', 'COUNTERED']),
    __metadata("design:type", String)
], RespondOrderExtensionDto.prototype, "response", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(14),
    __metadata("design:type", Number)
], RespondOrderExtensionDto.prototype, "counterDays", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], RespondOrderExtensionDto.prototype, "note", void 0);
class OpenOrderDisputeDto {
}
exports.OpenOrderDisputeDto = OpenOrderDisputeDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], OpenOrderDisputeDto.prototype, "description", void 0);
class RequestCustomOrderExtensionDto {
}
exports.RequestCustomOrderExtensionDto = RequestCustomOrderExtensionDto;
__decorate([
    (0, class_validator_1.IsEnum)(['PRODUCTION', 'DELIVERY', 'BOTH']),
    __metadata("design:type", String)
], RequestCustomOrderExtensionDto.prototype, "targetType", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(7),
    __metadata("design:type", Number)
], RequestCustomOrderExtensionDto.prototype, "requestedExtraDays", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], RequestCustomOrderExtensionDto.prototype, "reason", void 0);
class RespondCustomOrderExtensionDto {
}
exports.RespondCustomOrderExtensionDto = RespondCustomOrderExtensionDto;
__decorate([
    (0, class_validator_1.IsIn)(['ACCEPTED', 'REJECTED', 'COUNTERED']),
    __metadata("design:type", String)
], RespondCustomOrderExtensionDto.prototype, "response", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(7),
    __metadata("design:type", Number)
], RespondCustomOrderExtensionDto.prototype, "counterDays", void 0);
class OpenCustomOrderDisputeDto {
}
exports.OpenCustomOrderDisputeDto = OpenCustomOrderDisputeDto;
__decorate([
    (0, class_validator_1.IsIn)([
        'WRONG_ITEM',
        'MATERIAL_DEFECT',
        'MEASUREMENT_NON_COMPLIANCE',
        'UNFINISHED_WORK',
        'NON_DELIVERY',
        'UNREASONABLE_DELAY',
        'OTHER',
    ]),
    __metadata("design:type", String)
], OpenCustomOrderDisputeDto.prototype, "issueType", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], OpenCustomOrderDisputeDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], OpenCustomOrderDisputeDto.prototype, "evidenceJson", void 0);
//# sourceMappingURL=messaging.dto.js.map