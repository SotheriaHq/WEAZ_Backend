import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PhysicalVerificationBrandResponse,
  PhysicalVerificationProofKind,
} from '@prisma/client';

export class AssignPhysicalVerificationDto {
  @IsUUID()
  agentId!: string;
}

export class ProposeVisitDto {
  /**
   * The times the agent can attend.
   *
   * A LIST, not one appointment: the brand's only ways to answer are to take
   * one of these, take a different one of these, or decline, so offering more
   * than one is what makes a reschedule possible without a new negotiation.
   */
  @IsArray()
  @IsISO8601({ strict: false }, { each: true })
  slots!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BrandVisitReplyDto {
  @IsEnum(PhysicalVerificationBrandResponse)
  response!: PhysicalVerificationBrandResponse;

  /** Required unless declining. Must be one of the offered slots. */
  @IsOptional()
  @IsISO8601({ strict: false })
  selectedSlot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AddPhysicalVerificationProofDto {
  @IsOptional()
  @IsEnum(PhysicalVerificationProofKind)
  kind?: PhysicalVerificationProofKind;

  @IsString()
  @MaxLength(512)
  fileKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  caption?: string;
}

export class DecidePhysicalVerificationDto {
  @IsEnum(['PASSED', 'FAILED'])
  outcome!: 'PASSED' | 'FAILED';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Required when failing: a rejection a brand cannot read is not a reason. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  failureReason?: string;
}
