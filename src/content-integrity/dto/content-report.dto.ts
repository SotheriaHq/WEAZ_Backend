import {
  ContentReportReasonCode,
  ContentReportTargetType,
} from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ContentReportCreateDto {
  @IsEnum(ContentReportTargetType)
  targetType!: ContentReportTargetType;

  @IsUUID()
  targetId!: string;

  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @IsEnum(ContentReportReasonCode)
  reasonCode!: ContentReportReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
