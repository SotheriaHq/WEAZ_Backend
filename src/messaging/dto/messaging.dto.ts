import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsEnum,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class QueryMessagesDto {
  @IsOptional()
  @IsDateString()
  cursorCreatedAt?: string;

  @ValidateIf((value) => Boolean((value as QueryMessagesDto).cursorCreatedAt))
  @IsUUID('4')
  @IsOptional()
  cursorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class QueryInboxDto {
  @IsOptional()
  @IsDateString()
  cursorLastMessageAt?: string;

  @ValidateIf((value) => Boolean((value as QueryInboxDto).cursorLastMessageAt))
  @IsUUID('4')
  @IsOptional()
  cursorThreadId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(['all', 'unread', 'archived'])
  filter?: 'all' | 'unread' | 'archived';

  @IsOptional()
  @IsIn(['all', 'DIRECT', 'INQUIRY', 'STANDARD_ORDER', 'CUSTOM_ORDER'])
  contextType?: 'all' | 'DIRECT' | 'INQUIRY' | 'STANDARD_ORDER' | 'CUSTOM_ORDER';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class SendMessageDto {
  @IsUUID('4')
  clientMessageId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bodyText?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsUUID('4', { each: true })
  attachmentFileIds?: string[];
}

export class QueryThreadOrdersDto {
  @IsOptional()
  @IsIn(['all', 'active', 'closed', 'cancelled', 'disputed'])
  filter?: 'all' | 'active' | 'closed' | 'cancelled' | 'disputed';
}

export class MarkThreadReadDto {
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;
}

export class UpdateThreadPreferencesDto {
  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsBoolean()
  markRead?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  muteForHours?: number;

  @IsOptional()
  @IsBoolean()
  unmute?: boolean;
}

export class ModerateMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AdminSystemMessageDto {
  @IsString()
  @MaxLength(2000)
  bodyText!: string;
}

export class QueryThreadSummaryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  includeUnreadCount?: string;
}

export class BulkQueryThreadSummaryDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @MinLength(1, { each: true })
  @IsUUID('4', { each: true })
  contextIds!: string[];

  @IsOptional()
  @IsIn(['true', 'false'])
  includeUnreadCount?: string;
}

export class RequestOrderExtensionDto {
  @IsInt()
  @Min(1)
  @Max(5)
  requestedExtraDays!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class RespondOrderExtensionDto {
  @IsIn(['ACCEPTED', 'REJECTED', 'COUNTERED'])
  response!: 'ACCEPTED' | 'REJECTED' | 'COUNTERED';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(14)
  counterDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class OpenOrderDisputeDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;
}

export class RequestCustomOrderExtensionDto {
  @IsEnum(['PRODUCTION', 'DELIVERY', 'BOTH'])
  targetType!: 'PRODUCTION' | 'DELIVERY' | 'BOTH';

  @IsInt()
  @Min(1)
  @Max(7)
  requestedExtraDays!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class RespondCustomOrderExtensionDto {
  @IsIn(['ACCEPTED', 'REJECTED', 'COUNTERED'])
  response!: 'ACCEPTED' | 'REJECTED' | 'COUNTERED';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  counterDays?: number;
}

export class OpenCustomOrderDisputeDto {
  @IsIn([
    'WRONG_ITEM',
    'MATERIAL_DEFECT',
    'MEASUREMENT_NON_COMPLIANCE',
    'UNFINISHED_WORK',
    'NON_DELIVERY',
    'UNREASONABLE_DELAY',
    'OTHER',
  ])
  issueType!:
    | 'WRONG_ITEM'
    | 'MATERIAL_DEFECT'
    | 'MEASUREMENT_NON_COMPLIANCE'
    | 'UNFINISHED_WORK'
    | 'NON_DELIVERY'
    | 'UNREASONABLE_DELAY'
    | 'OTHER';

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsObject()
  evidenceJson?: Record<string, unknown>;
}
