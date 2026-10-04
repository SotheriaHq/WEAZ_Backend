import {
  CustomOrderDisputeResolution,
  CustomOrderDisputeStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class QueryDisputeQueueDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(CustomOrderDisputeStatus)
  status?: CustomOrderDisputeStatus;

  /** How a handler triages their own queue. */
  @IsOptional()
  @IsEnum(['unclaimed', 'mine', 'others', 'overdue'] as never)
  ownership?: 'unclaimed' | 'mine' | 'others' | 'overdue';

  @IsOptional()
  @IsString()
  reasonType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

/**
 * Handing a dispute on.
 *
 * A successor is required, not optional: there is no way to simply put a case
 * down. The reason is required too — a SuperAdmin is being asked to approve
 * this, and "no reason given" is not something they can weigh.
 */
export class RequestDisputeHandoverDto {
  @IsUUID()
  successorAdminId!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}

export class DecideDisputeHandoverDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ProposeDisputeResolutionDto {
  @IsEnum(CustomOrderDisputeResolution)
  resolution!: CustomOrderDisputeResolution;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * Only for MEDIATED_EXTENSION. Bounded here as a first line of defence; the
   * real test is against the order's remaining budget in the policy, because
   * the per-request cap is not the only limit that applies.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  extraDays?: number;

  /** Only for PARTIAL_REFUND. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  refundAmount?: number;
}

/** A party's answer to a proposed resolution. */
export class RespondToDisputeProposalDto {
  @IsBoolean()
  accept!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
