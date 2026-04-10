import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ShareSizeFitDto {
  @IsOptional()
  @IsUUID()
  profileUserId?: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @IsOptional()
  @IsString()
  targetUserIdentifier?: string;

  @IsOptional()
  @IsBoolean()
  canReshare?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

