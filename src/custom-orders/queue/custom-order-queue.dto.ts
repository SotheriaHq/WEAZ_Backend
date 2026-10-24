import { Transform } from 'class-transformer';
import { CapacityCampaignResetMode, RunwayBrandNoticeKind, SubscriptionTierKey } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class QueueRevisionDto {
  @IsOptional() @IsInt() @Min(0) expectedRevision?: number;
}
export class QueueRefundListDto {
  @IsOptional() @IsUUID() cursor?: string;
}
export class QueueReasonDto extends QueueRevisionDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class QueueIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4', { each: true }) orderIds: string[];
}
export class QueueCancelManyDto extends QueueIdsDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class QueueSettingsDto { @Transform(({ obj, key }) => obj[key]) @IsBoolean() queueJumpEnabled: boolean; }
export class QueueIntakeDto {
  @Transform(({ obj, key }) => obj[key]) @IsBoolean() blocked: boolean;
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class QueueOverrideDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(1000) reason?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) activeCap: number | null;
  @IsOptional() @IsDateString() expiresAt?: string | null;
}
export class QueueTierDto {
  @IsOptional() @IsDateString() expectedUpdatedAt?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) maxActive?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) maxInDelivery?: number;
  @IsOptional() @IsInt() @Min(100) @Max(100000000) monthlyPriceNgn?: number;
}
export class QueuePublishNoticeDto { @Transform(({ obj, key }) => obj[key]) @IsBoolean() published: boolean; }
export class QueueReconcileRefundDto { @IsString() @MinLength(1) @MaxLength(120) providerRefundId: string; }
export class QueueAssignTierDto {
  @IsEnum(SubscriptionTierKey) tierKey: SubscriptionTierKey;
  @IsString() @MinLength(3) @MaxLength(1000) reason: string;
}
export class QueueCampaignDto {
  @IsInt() @Min(-100000) @Max(100000) deltaActive: number;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsEnum(CapacityCampaignResetMode) resetMode: CapacityCampaignResetMode;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class QueueNoticeDto {
  @IsString() @MinLength(1) @MaxLength(160) title: string;
  @IsString() @MinLength(1) @MaxLength(3000) body: string;
  @IsEnum(RunwayBrandNoticeKind) kind: RunwayBrandNoticeKind;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsOptional() @Transform(({ obj, key }) => obj[key]) @IsBoolean() published?: boolean;
}
