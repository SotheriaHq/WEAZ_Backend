import { ContentTarget } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class QuarantineThreadsDto {
  @IsUUID()
  userId: string;

  @IsUUID()
  contentId: string;

  @IsEnum(ContentTarget)
  contentType: ContentTarget;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
