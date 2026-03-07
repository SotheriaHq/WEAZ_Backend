import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewModerationItemDto {
  @IsString()
  @IsIn(['approve', 'reject'])
  action: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
