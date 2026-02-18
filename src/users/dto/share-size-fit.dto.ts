import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class ShareSizeFitDto {
  @IsOptional()
  @IsUUID()
  profileUserId?: string;

  @IsUUID()
  targetUserId: string;

  @IsOptional()
  @IsBoolean()
  canReshare?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

