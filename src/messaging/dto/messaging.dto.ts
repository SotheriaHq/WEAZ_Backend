import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
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

export class MarkThreadReadDto {
  @IsOptional()
  @IsUUID('4')
  upToMessageId?: string;
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
