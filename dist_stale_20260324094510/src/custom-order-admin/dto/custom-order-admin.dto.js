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
exports.DecideCustomOrderExceptionReviewDto = exports.QueryCustomOrderExceptionReviewsDto = exports.UpdateCustomOrderRetentionHoldDto = exports.CancelPaidCustomOrderDto = exports.EscalateCustomOrderRefundReviewDto = exports.FlagCustomOrderRiskDto = exports.AdminCustomOrderReminderDto = exports.UpdateCustomOrderDisputeDto = exports.QueryCustomOrderRefundReviewsDto = exports.QueryCustomOrderRiskDashboardDto = exports.ReleaseCustomOrderLedgerAllocationsDto = exports.QueryCustomOrderLedgerAllocationsDto = exports.QueryCustomOrderDisputesDto = exports.QueryStaleCustomOrdersDto = exports.QueryAdminCustomOrdersDto = exports.UpdateAdminCustomFabricRuleBasisDto = exports.CreateAdminCustomFabricRuleBasisDto = exports.QueryAdminCustomFabricRuleBasesDto = exports.ReviewCustomFabricRuleBasisDto = void 0;
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
const class_validator_1 = require("class-validator");
class ReviewCustomFabricRuleBasisDto {
}
exports.ReviewCustomFabricRuleBasisDto = ReviewCustomFabricRuleBasisDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomFabricRuleBasisStatus),
    __metadata("design:type", String)
], ReviewCustomFabricRuleBasisDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], ReviewCustomFabricRuleBasisDto.prototype, "moderationNotes", void 0);
class QueryAdminCustomFabricRuleBasesDto {
}
exports.QueryAdminCustomFabricRuleBasesDto = QueryAdminCustomFabricRuleBasesDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Boolean),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], QueryAdminCustomFabricRuleBasesDto.prototype, "includeBrandOnly", void 0);
class CreateAdminCustomFabricRuleBasisDto {
}
exports.CreateAdminCustomFabricRuleBasisDto = CreateAdminCustomFabricRuleBasisDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], CreateAdminCustomFabricRuleBasisDto.prototype, "label", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], CreateAdminCustomFabricRuleBasisDto.prototype, "measurementKeys", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.Gender),
    __metadata("design:type", String)
], CreateAdminCustomFabricRuleBasisDto.prototype, "gender", void 0);
class UpdateAdminCustomFabricRuleBasisDto {
}
exports.UpdateAdminCustomFabricRuleBasisDto = UpdateAdminCustomFabricRuleBasisDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], UpdateAdminCustomFabricRuleBasisDto.prototype, "label", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], UpdateAdminCustomFabricRuleBasisDto.prototype, "measurementKeys", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.Gender),
    __metadata("design:type", String)
], UpdateAdminCustomFabricRuleBasisDto.prototype, "gender", void 0);
class QueryAdminCustomOrdersDto {
}
exports.QueryAdminCustomOrdersDto = QueryAdminCustomOrdersDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryAdminCustomOrdersDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryAdminCustomOrdersDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderStatus),
    __metadata("design:type", String)
], QueryAdminCustomOrdersDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderProgressStage),
    __metadata("design:type", String)
], QueryAdminCustomOrdersDto.prototype, "stage", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryAdminCustomOrdersDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryAdminCustomOrdersDto.prototype, "q", void 0);
class QueryStaleCustomOrdersDto {
}
exports.QueryStaleCustomOrdersDto = QueryStaleCustomOrdersDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryStaleCustomOrdersDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryStaleCustomOrdersDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryStaleCustomOrdersDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Boolean),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], QueryStaleCustomOrdersDto.prototype, "escalatedOnly", void 0);
class QueryCustomOrderDisputesDto {
}
exports.QueryCustomOrderDisputesDto = QueryCustomOrderDisputesDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryCustomOrderDisputesDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryCustomOrderDisputesDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderDisputeStatus),
    __metadata("design:type", String)
], QueryCustomOrderDisputesDto.prototype, "status", void 0);
class QueryCustomOrderLedgerAllocationsDto {
}
exports.QueryCustomOrderLedgerAllocationsDto = QueryCustomOrderLedgerAllocationsDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryCustomOrderLedgerAllocationsDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryCustomOrderLedgerAllocationsDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderLedgerAllocationsDto.prototype, "customOrderId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderLedgerAllocationsDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderLedgerAllocationsDto.prototype, "payoutId", void 0);
class ReleaseCustomOrderLedgerAllocationsDto {
}
exports.ReleaseCustomOrderLedgerAllocationsDto = ReleaseCustomOrderLedgerAllocationsDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ReleaseCustomOrderLedgerAllocationsDto.prototype, "customOrderId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ReleaseCustomOrderLedgerAllocationsDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsString)({ each: true }),
    __metadata("design:type", Array)
], ReleaseCustomOrderLedgerAllocationsDto.prototype, "allocationIds", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Boolean),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], ReleaseCustomOrderLedgerAllocationsDto.prototype, "dryRun", void 0);
class QueryCustomOrderRiskDashboardDto {
}
exports.QueryCustomOrderRiskDashboardDto = QueryCustomOrderRiskDashboardDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(90),
    __metadata("design:type", Number)
], QueryCustomOrderRiskDashboardDto.prototype, "days", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(25),
    __metadata("design:type", Number)
], QueryCustomOrderRiskDashboardDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderRiskDashboardDto.prototype, "brandId", void 0);
class QueryCustomOrderRefundReviewsDto {
}
exports.QueryCustomOrderRefundReviewsDto = QueryCustomOrderRefundReviewsDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryCustomOrderRefundReviewsDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryCustomOrderRefundReviewsDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderRefundReviewsDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderRefundReviewsDto.prototype, "q", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Boolean),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], QueryCustomOrderRefundReviewsDto.prototype, "includeSettled", void 0);
class UpdateCustomOrderDisputeDto {
}
exports.UpdateCustomOrderDisputeDto = UpdateCustomOrderDisputeDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderDisputeStatus),
    __metadata("design:type", String)
], UpdateCustomOrderDisputeDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderDisputeResolution),
    __metadata("design:type", String)
], UpdateCustomOrderDisputeDto.prototype, "resolution", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], UpdateCustomOrderDisputeDto.prototype, "adminNotes", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateCustomOrderDisputeDto.prototype, "assignedAdminId", void 0);
class AdminCustomOrderReminderDto {
}
exports.AdminCustomOrderReminderDto = AdminCustomOrderReminderDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], AdminCustomOrderReminderDto.prototype, "note", void 0);
class FlagCustomOrderRiskDto {
}
exports.FlagCustomOrderRiskDto = FlagCustomOrderRiskDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], FlagCustomOrderRiskDto.prototype, "reason", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], FlagCustomOrderRiskDto.prototype, "note", void 0);
class EscalateCustomOrderRefundReviewDto {
}
exports.EscalateCustomOrderRefundReviewDto = EscalateCustomOrderRefundReviewDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], EscalateCustomOrderRefundReviewDto.prototype, "reason", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], EscalateCustomOrderRefundReviewDto.prototype, "note", void 0);
class CancelPaidCustomOrderDto {
}
exports.CancelPaidCustomOrderDto = CancelPaidCustomOrderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], CancelPaidCustomOrderDto.prototype, "reason", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], CancelPaidCustomOrderDto.prototype, "note", void 0);
class UpdateCustomOrderRetentionHoldDto {
}
exports.UpdateCustomOrderRetentionHoldDto = UpdateCustomOrderRetentionHoldDto;
__decorate([
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], UpdateCustomOrderRetentionHoldDto.prototype, "clear", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderRetentionHoldType),
    __metadata("design:type", String)
], UpdateCustomOrderRetentionHoldDto.prototype, "holdType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], UpdateCustomOrderRetentionHoldDto.prototype, "reason", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Date),
    __metadata("design:type", Date)
], UpdateCustomOrderRetentionHoldDto.prototype, "holdUntil", void 0);
class QueryCustomOrderExceptionReviewsDto {
}
exports.QueryCustomOrderExceptionReviewsDto = QueryCustomOrderExceptionReviewsDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryCustomOrderExceptionReviewsDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryCustomOrderExceptionReviewsDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderExceptionReviewsDto.prototype, "brandId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrderExceptionReviewsDto.prototype, "status", void 0);
class DecideCustomOrderExceptionReviewDto {
}
exports.DecideCustomOrderExceptionReviewDto = DecideCustomOrderExceptionReviewDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], DecideCustomOrderExceptionReviewDto.prototype, "decision", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], DecideCustomOrderExceptionReviewDto.prototype, "rationale", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], DecideCustomOrderExceptionReviewDto.prototype, "approvedQuoteTotal", void 0);
//# sourceMappingURL=custom-order-admin.dto.js.map