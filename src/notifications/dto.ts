import { IsInt, IsOptional, IsString, IsISO8601, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsISO8601()
  cursor?: string; // ISO date string of createdAt

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsString()
  type?: string; // filter by NotificationType
}

export class MarkReadDto {
  @IsOptional()
  @IsString()
  id?: string;
}
