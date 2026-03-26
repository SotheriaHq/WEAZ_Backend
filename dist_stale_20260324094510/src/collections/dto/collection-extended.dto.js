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
exports.CustomFitInquiryResponse = exports.CustomFitInquiryDto = exports.DraftSaveConflictResponse = exports.DraftSaveDto = exports.DraftConflictDto = exports.DraftSessionDto = exports.CollectionPriceImpact = exports.PriceChangePreviewResponse = exports.PriceChangePreviewDto = exports.BulkUploadRetryDto = exports.BulkUploadError = exports.BulkUploadStatusDto = exports.BulkUploadRowDto = exports.BulkUploadInitiateDto = exports.CartPreviewSummary = exports.UnavailableCartPreviewItem = exports.CartPreviewVariant = exports.CartPreviewItem = exports.CollectionCartPreviewResponseDto = void 0;
const class_validator_1 = require("class-validator");
class CollectionCartPreviewResponseDto {
}
exports.CollectionCartPreviewResponseDto = CollectionCartPreviewResponseDto;
class CartPreviewItem {
}
exports.CartPreviewItem = CartPreviewItem;
class CartPreviewVariant {
}
exports.CartPreviewVariant = CartPreviewVariant;
class UnavailableCartPreviewItem extends CartPreviewItem {
}
exports.UnavailableCartPreviewItem = UnavailableCartPreviewItem;
class CartPreviewSummary {
}
exports.CartPreviewSummary = CartPreviewSummary;
class BulkUploadInitiateDto {
}
exports.BulkUploadInitiateDto = BulkUploadInitiateDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadInitiateDto.prototype, "collectionId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadInitiateDto.prototype, "mode", void 0);
class BulkUploadRowDto {
}
exports.BulkUploadRowDto = BulkUploadRowDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "product_name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], BulkUploadRowDto.prototype, "price", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], BulkUploadRowDto.prototype, "sale_price", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "sku", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "sizes", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "colors", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "stock", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "tags", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], BulkUploadRowDto.prototype, "images", void 0);
class BulkUploadStatusDto {
}
exports.BulkUploadStatusDto = BulkUploadStatusDto;
class BulkUploadError {
}
exports.BulkUploadError = BulkUploadError;
class BulkUploadRetryDto {
}
exports.BulkUploadRetryDto = BulkUploadRetryDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsNumber)({}, { each: true }),
    __metadata("design:type", Array)
], BulkUploadRetryDto.prototype, "rowIndices", void 0);
class PriceChangePreviewDto {
}
exports.PriceChangePreviewDto = PriceChangePreviewDto;
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], PriceChangePreviewDto.prototype, "newPrice", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    __metadata("design:type", Number)
], PriceChangePreviewDto.prototype, "newSalePrice", void 0);
class PriceChangePreviewResponse {
}
exports.PriceChangePreviewResponse = PriceChangePreviewResponse;
class CollectionPriceImpact {
}
exports.CollectionPriceImpact = CollectionPriceImpact;
class DraftSessionDto {
}
exports.DraftSessionDto = DraftSessionDto;
class DraftConflictDto {
}
exports.DraftConflictDto = DraftConflictDto;
class DraftSaveDto {
}
exports.DraftSaveDto = DraftSaveDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], DraftSaveDto.prototype, "title", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], DraftSaveDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], DraftSaveDto.prototype, "expectedVersion", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], DraftSaveDto.prototype, "deviceInfo", void 0);
class DraftSaveConflictResponse {
}
exports.DraftSaveConflictResponse = DraftSaveConflictResponse;
class CustomFitInquiryDto {
}
exports.CustomFitInquiryDto = CustomFitInquiryDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFitInquiryDto.prototype, "collectionId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFitInquiryDto.prototype, "productId", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFitInquiryDto.prototype, "message", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFitInquiryDto.prototype, "measurements", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CustomFitInquiryDto.prototype, "preferredSize", void 0);
class CustomFitInquiryResponse {
}
exports.CustomFitInquiryResponse = CustomFitInquiryResponse;
//# sourceMappingURL=collection-extended.dto.js.map