import { IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateSizeFitDto {
  @IsOptional()
  @IsObject()
  measurements?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(60)
  requireUpdateEveryDays?: number;
}

