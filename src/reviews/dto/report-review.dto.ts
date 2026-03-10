import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductReviewReportReason } from '@prisma/client';

export class ReportReviewDto {
    @IsEnum(ProductReviewReportReason)
    reason: ProductReviewReportReason;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    details?: string;
}
