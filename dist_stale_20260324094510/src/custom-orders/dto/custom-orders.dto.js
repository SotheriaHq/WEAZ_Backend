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
exports.QueryCustomOrdersDto = exports.UpdateCustomOrderLifecycleStatusDto = exports.BrandRespondToCustomOrderExtensionCounterDto = exports.CreateCustomOrderExtensionRequestDto = exports.UpdateCustomOrderProgressStageDto = exports.RejectCustomOrderDto = exports.AcceptCustomOrderDto = exports.RespondToCustomOrderExtensionDto = exports.UpdateCustomOrderMeasurementsDto = exports.ReportCustomOrderIssueDto = exports.ConfirmCustomOrderDeliveryDto = exports.CancelCustomOrderDto = exports.VerifyCustomOrderPaymentDto = exports.InitializeCustomOrderPaymentDto = exports.CreateExceptionReviewRequestDto = exports.UpdateDisplayChartPreferenceDto = exports.CreateCustomOrderDto = exports.CustomOrderPricePreviewDto = void 0;
const class_transformer_1 = require("class-transformer");
const client_1 = require("@prisma/client");
const class_validator_1 = require("class-validator");
class CustomOrderPricePreviewDto {
}
exports.CustomOrderPricePreviewDto = CustomOrderPricePreviewDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "configurationId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "configurationVersionId", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CustomOrderPricePreviewDto.prototype, "measurementValues", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CustomOrderPricePreviewDto.prototype, "rushSelected", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CustomOrderPricePreviewDto.prototype, "shippingAddress", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "idempotencyKey", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "pricingChartFamily", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "displayChartFamily", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomOrderPricePreviewDto.prototype, "resolverPolicy", void 0);
class CreateCustomOrderDto {
}
exports.CreateCustomOrderDto = CreateCustomOrderDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateCustomOrderDto.prototype, "checkoutIntentId", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateCustomOrderDto.prototype, "configurationId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateCustomOrderDto.prototype, "configurationVersionId", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateCustomOrderDto.prototype, "measurementValues", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateCustomOrderDto.prototype, "rushSelected", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateCustomOrderDto.prototype, "shippingAddress", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateCustomOrderDto.prototype, "contactInfo", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.Length)(3, 120),
    __metadata("design:type", String)
], CreateCustomOrderDto.prototype, "customerName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], CreateCustomOrderDto.prototype, "idempotencyKey", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], CreateCustomOrderDto.prototype, "noDirectMatchAcknowledged", void 0);
class UpdateDisplayChartPreferenceDto {
}
exports.UpdateDisplayChartPreferenceDto = UpdateDisplayChartPreferenceDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateDisplayChartPreferenceDto.prototype, "displayChartFamily", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], UpdateDisplayChartPreferenceDto.prototype, "updatedAtMs", void 0);
class CreateExceptionReviewRequestDto {
}
exports.CreateExceptionReviewRequestDto = CreateExceptionReviewRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], CreateExceptionReviewRequestDto.prototype, "reason", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], CreateExceptionReviewRequestDto.prototype, "requestedQuoteTotal", void 0);
class InitializeCustomOrderPaymentDto {
}
exports.InitializeCustomOrderPaymentDto = InitializeCustomOrderPaymentDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.PaymentMethod),
    __metadata("design:type", String)
], InitializeCustomOrderPaymentDto.prototype, "paymentMethod", void 0);
__decorate([
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], InitializeCustomOrderPaymentDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], InitializeCustomOrderPaymentDto.prototype, "callbackUrl", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], InitializeCustomOrderPaymentDto.prototype, "paymentData", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(120),
    __metadata("design:type", String)
], InitializeCustomOrderPaymentDto.prototype, "idempotencyKey", void 0);
class VerifyCustomOrderPaymentDto {
}
exports.VerifyCustomOrderPaymentDto = VerifyCustomOrderPaymentDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], VerifyCustomOrderPaymentDto.prototype, "reference", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], VerifyCustomOrderPaymentDto.prototype, "gateway", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], VerifyCustomOrderPaymentDto.prototype, "otp", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], VerifyCustomOrderPaymentDto.prototype, "statusHint", void 0);
class CancelCustomOrderDto {
}
exports.CancelCustomOrderDto = CancelCustomOrderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(300),
    __metadata("design:type", String)
], CancelCustomOrderDto.prototype, "reason", void 0);
class ConfirmCustomOrderDeliveryDto {
}
exports.ConfirmCustomOrderDeliveryDto = ConfirmCustomOrderDeliveryDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], ConfirmCustomOrderDeliveryDto.prototype, "note", void 0);
class ReportCustomOrderIssueDto {
}
exports.ReportCustomOrderIssueDto = ReportCustomOrderIssueDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderIssueType),
    __metadata("design:type", String)
], ReportCustomOrderIssueDto.prototype, "issueType", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(10),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], ReportCustomOrderIssueDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], ReportCustomOrderIssueDto.prototype, "evidenceJson", void 0);
class UpdateCustomOrderMeasurementsDto {
}
exports.UpdateCustomOrderMeasurementsDto = UpdateCustomOrderMeasurementsDto;
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateCustomOrderMeasurementsDto.prototype, "measurementValues", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], UpdateCustomOrderMeasurementsDto.prototype, "reason", void 0);
class RespondToCustomOrderExtensionDto {
}
exports.RespondToCustomOrderExtensionDto = RespondToCustomOrderExtensionDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderExtensionResponseStatus),
    __metadata("design:type", String)
], RespondToCustomOrderExtensionDto.prototype, "response", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(7),
    __metadata("design:type", Number)
], RespondToCustomOrderExtensionDto.prototype, "counterDays", void 0);
class AcceptCustomOrderDto {
}
exports.AcceptCustomOrderDto = AcceptCustomOrderDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], AcceptCustomOrderDto.prototype, "note", void 0);
class RejectCustomOrderDto {
}
exports.RejectCustomOrderDto = RejectCustomOrderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], RejectCustomOrderDto.prototype, "reason", void 0);
class UpdateCustomOrderProgressStageDto {
}
exports.UpdateCustomOrderProgressStageDto = UpdateCustomOrderProgressStageDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderProgressStage),
    __metadata("design:type", String)
], UpdateCustomOrderProgressStageDto.prototype, "stage", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], UpdateCustomOrderProgressStageDto.prototype, "note", void 0);
class CreateCustomOrderExtensionRequestDto {
}
exports.CreateCustomOrderExtensionRequestDto = CreateCustomOrderExtensionRequestDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderExtensionTargetType),
    __metadata("design:type", String)
], CreateCustomOrderExtensionRequestDto.prototype, "targetType", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(7),
    __metadata("design:type", Number)
], CreateCustomOrderExtensionRequestDto.prototype, "requestedExtraDays", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(5),
    (0, class_validator_1.MaxLength)(1000),
    __metadata("design:type", String)
], CreateCustomOrderExtensionRequestDto.prototype, "reason", void 0);
class BrandRespondToCustomOrderExtensionCounterDto {
}
exports.BrandRespondToCustomOrderExtensionCounterDto = BrandRespondToCustomOrderExtensionCounterDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderExtensionResponseStatus),
    __metadata("design:type", String)
], BrandRespondToCustomOrderExtensionCounterDto.prototype, "response", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], BrandRespondToCustomOrderExtensionCounterDto.prototype, "note", void 0);
class UpdateCustomOrderLifecycleStatusDto {
}
exports.UpdateCustomOrderLifecycleStatusDto = UpdateCustomOrderLifecycleStatusDto;
__decorate([
    (0, class_validator_1.IsEnum)(client_1.CustomOrderStatus),
    __metadata("design:type", String)
], UpdateCustomOrderLifecycleStatusDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], UpdateCustomOrderLifecycleStatusDto.prototype, "note", void 0);
class QueryCustomOrdersDto {
}
exports.QueryCustomOrdersDto = QueryCustomOrdersDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], QueryCustomOrdersDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], QueryCustomOrdersDto.prototype, "limit", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderStatus),
    __metadata("design:type", String)
], QueryCustomOrdersDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(client_1.CustomOrderProgressStage),
    __metadata("design:type", String)
], QueryCustomOrdersDto.prototype, "stage", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], QueryCustomOrdersDto.prototype, "q", void 0);
//# sourceMappingURL=custom-orders.dto.js.map