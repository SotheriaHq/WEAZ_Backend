import { ContentTarget } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsUUID,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';

export class BulkRemoveEntryDto {
  @IsUUID()
  userId: string;

  @IsUUID()
  contentId: string;

  @IsEnum(ContentTarget)
  contentType: ContentTarget;
}

export class BulkRemoveThreadsDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => BulkRemoveEntryDto)
  entries: BulkRemoveEntryDto[];
}
